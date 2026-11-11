import { app, Tray, Menu, BrowserWindow, nativeImage, screen, ipcMain, dialog } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { getRunner, getStore } from './appState';
import {
  IPC,
  type ContinueConversationPayload,
  type CreateTaskPayload,
  type DeleteConversationsPayload,
  type PtyResizePayload,
  type PtySpawnPayload,
  type PtyWritePayload,
  type PushEventPayload,
  type PushStatusPayload,
  type SetProviderConfigPayload,
  type TranscriptRequest,
  type SwitchToCodexPayload,
  type SetConversationTitlePayload,
  type SetConversationPinnedPayload,
} from '../src/shared/ipc';
import * as inspector from '../src/core/inspector';
import * as agentConfig from '../src/core/agentConfig';
import { fixPath } from './fixPath';
import { attachPty, killAllPty, killPty, ptyEvents, resizePty, writePty, stopPty } from '../src/core/ptyManager';
import { ConversationHandoff } from '../src/core/conversationHandoff';
import type { AgentKind, ConversationSummary, TaskRecord } from '../src/core/types';
import { compareConversations } from '../src/shared/conversationOrder';

// Electron main process entry point: owns the Tray icon + single panel
// window, wires every IPC channel from src/shared/ipc.ts to the actual
// taskStore/taskRunner/inspector calls, and is the only place that talks to
// Electron APIs directly (everything in src/core is plain Node, importable
// from a test script too — see the ELECTRON_RUN_AS_NODE tricks in README).

const isDev = process.env.NODE_ENV === 'development';

let tray: Tray | null = null;
let panel: BrowserWindow | null = null;

// Frameless (no OS title bar) so we can fully own the look — see
// styles.css's `-webkit-app-region: drag` on .panel-header for how dragging
// still works without native chrome.
function createPanel(): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 480,
    minHeight: 360,
    show: false,
    frame: false,
    resizable: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '../../dist-renderer/index.html'));
  }

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log('[renderer console]', level, message, `(${sourceId}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.log('[renderer did-fail-load]', errorCode, errorDescription, validatedURL);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log('[renderer render-process-gone]', JSON.stringify(details));
  });

  // No blur-hide: the panel is now draggable/resizable like a real window
  // (see the drag-to-move + resize feature), so hiding on blur made it
  // vanish the instant you clicked anything else — annoying, not a popover
  // anymore. Closing is explicit now, via the header's close button.

  return win;
}

// Centers the panel horizontally under the tray icon, just below it, clamped
// to the display's work area so it can't hang off the right edge on an
// ultrawide monitor. Only called once (see hasBeenPositioned below).
function positionPanelUnderTray(win: BrowserWindow, trayBounds: Electron.Rectangle) {
  const { width, height } = win.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  const y = Math.round(trayBounds.y + trayBounds.height);
  const maxX = display.workArea.x + display.workArea.width - width;
  win.setBounds({ x: Math.min(Math.max(x, display.workArea.x), maxX), y, width, height });
}

let hasBeenPositioned = false;

function togglePanel() {
  if (!tray || !panel) return;
  if (panel.isVisible()) {
    panel.hide();
    return;
  }
  // Only snap under the tray icon the first time — once the user drags or
  // resizes it, later opens should reopen wherever they left it.
  if (!hasBeenPositioned) {
    positionPanelUnderTray(panel, tray.getBounds());
    hasBeenPositioned = true;
  }
  panel.show();
  panel.focus();
}

/** Merges the on-disk session history (every session either CLI has ever
 * written, whether AgentHub launched it or not) with taskStore's tracked
 * tasks (which carry live status). Keyed by `agent:sessionId` — the disk
 * scan is the source of truth for which conversations exist at all; a
 * matching tracked task just overlays status/taskId on top. */
async function listConversations(): Promise<ConversationSummary[]> {
  const store = getStore();
  const tasks = store.listTasks();
  const pins = store.getConversationPins();
  const pinsFor = (agent: AgentKind) => new Map(
    [...pins].filter(([key]) => key.startsWith(`${agent}:`)).map(([key, pin]) => [key.slice(agent.length + 1), pin.path])
  );

  const trackedBySession = new Map<string, TaskRecord>();
  for (const t of tasks) {
    if (!t.sessionId) continue;
    const key = `${t.agent}:${t.sessionId}`;
    const existing = trackedBySession.get(key);
    if (!existing || t.updatedAt > existing.updatedAt) {
      trackedBySession.set(key, t);
    }
  }

  const [codexHistory, claudeHistory] = await Promise.all([inspector.getCodexHistory(200, pinsFor('codex')), inspector.getClaudeHistory(200, pinsFor('claude'))]);

  const summaries = new Map<string, ConversationSummary>();
  const diskSessions: Array<{
    agent: AgentKind;
    id: string;
    cwd: string;
    title: string | null;
    fullTitle?: string;
    timestamp: string;
    path: string;
    lastModifiedAt?: string;
    mergedCount?: number;
  }> = [
    ...codexHistory.map((s) => ({ ...s, agent: 'codex' as const })),
    ...claudeHistory.map((s) => ({ ...s, agent: 'claude' as const })),
  ];

  for (const s of diskSessions) {
    const key = `${s.agent}:${s.id}`;
    const tracked = trackedBySession.get(key);
    // Recency = the newest of: tracked-task update (AgentHub headless
    // resumes), file mtime (terminal-mode turns, or resumes made outside
    // AgentHub entirely), and the creation timestamp (always-older
    // fallback). Sorting on creation time alone buried an old conversation
    // the user just resumed back at its creation date.
    const activityCandidates = [
      tracked ? new Date(tracked.updatedAt).getTime() : 0,
      s.lastModifiedAt ? new Date(s.lastModifiedAt).getTime() : 0,
      new Date(s.timestamp).getTime(),
    ];
    summaries.set(key, {
      agent: s.agent,
      sessionId: s.id,
      cwd: s.cwd,
      title: s.title,
      fullTitle: s.fullTitle,
      createdAt: s.timestamp,
      lastActivityAt: new Date(Math.max(...activityCandidates)).toISOString(),
      taskId: tracked?.id ?? null,
      status: tracked?.status ?? null,
      path: s.path,
      mergedCount: s.mergedCount,
    });
  }

  // A task whose session hasn't hit disk yet (just started, file not
  // flushed) still needs to show up — fall back to the prompt as a title.
  for (const [key, t] of trackedBySession) {
    if (summaries.has(key)) continue;
    summaries.set(key, {
      agent: t.agent,
      sessionId: t.sessionId as string,
      cwd: t.cwd,
      title: t.prompt.length > 80 ? `${t.prompt.slice(0, 80)}…` : t.prompt,
      fullTitle: t.prompt,
      createdAt: new Date(t.createdAt).toISOString(),
      lastActivityAt: new Date(t.updatedAt).toISOString(),
      taskId: t.id,
      status: t.status,
      path: null,
    });
  }

  const titles = store.getConversationTitles();
  for (const [key, summary] of summaries) {
    const title = titles.get(key);
    if (title) { summary.title = title; summary.fullTitle = title; }
    summary.pinnedAt = pins.get(key)?.pinnedAt ?? null;
  }
  return Array.from(summaries.values()).sort(compareConversations);
}

// One handler per IPC.* channel (see src/shared/ipc.ts), plus forwarding
// taskRunner's `event`/`status` EventEmitter output to the renderer as
// pushed messages (renderer can't subscribe to a main-process EventEmitter
// directly, only receive things sent to it).
function registerIpcHandlers() {
  const store = getStore();
  const runner = getRunner();
  const handoff = new ConversationHandoff(store, runner,
    path.join(os.homedir(), '.claude', 'projects'), path.join(os.homedir(), '.codex', 'sessions'), path.join(app.getPath('userData'), 'handoffs'), stopPty);

  ipcMain.handle(IPC.listTasks, () => store.listTasks());

  ipcMain.handle(IPC.getEvents, (_e, taskId: string) => store.getEvents(taskId));

  ipcMain.handle(IPC.createTask, (_e, payload: CreateTaskPayload) => {
    return runner.start(payload.agent, payload.cwd, payload.prompt);
  });

  ipcMain.handle(IPC.toolsStatus, (_e, agent: AgentKind) =>
    agent === 'codex' ? inspector.getCodexStatus() : inspector.getClaudeStatus()
  );
  ipcMain.handle(IPC.toolsSettings, (_e, agent: AgentKind) =>
    agent === 'codex' ? inspector.getCodexSettings() : inspector.getClaudeSettings()
  );
  ipcMain.handle(IPC.toolsSkills, (_e, agent: AgentKind) =>
    agent === 'codex' ? inspector.getCodexSkills() : inspector.getClaudeSkills()
  );

  ipcMain.handle(IPC.conversationsList, () => listConversations());

  ipcMain.handle(IPC.conversationsTranscript, (_e, req: TranscriptRequest) =>
    req.agent === 'codex' ? inspector.getCodexTranscript(req.path) : inspector.getClaudeTranscript(req.path)
  );

  ipcMain.handle(IPC.conversationsContinue, (_e, payload: ContinueConversationPayload) => {
    if (payload.agent === 'claude' && handoff.isSwitching(payload.sessionId)) throw new Error('此会话正在切换到 Codex。');
    return runner.resume(payload.agent, payload.cwd, payload.sessionId, payload.message);
  });
  ipcMain.handle(IPC.conversationsSwitchToCodex, (_e, payload: SwitchToCodexPayload) => handoff.switchToCodex(payload));
  ipcMain.handle(IPC.conversationsSwitchToClaude, (_e, payload: SwitchToCodexPayload) => handoff.switchToClaude(payload));
  ipcMain.handle(IPC.conversationsSetTitle, (_e, payload: SetConversationTitlePayload) =>
    store.setConversationTitle(payload.agent, payload.sessionId, payload.title)
  );
  ipcMain.handle(IPC.conversationsSetPinned, (_e, payload: SetConversationPinnedPayload) =>
    store.setConversationPinned(payload.agent, payload.sessionId, payload.pinned, payload.path)
  );

  // Best-effort per item — one bad delete (e.g. a session already gone)
  // shouldn't abort the rest of a bulk selection.
  ipcMain.handle(IPC.conversationsDelete, async (_e, payload: DeleteConversationsPayload) => {
    for (const item of payload.items) {
      try {
        if (item.agent === 'codex') {
          await inspector.deleteCodexSession(item.sessionId);
        } else if (item.path) {
          await inspector.deleteClaudeSession(item.path);
        }
      } catch (err) {
        console.log('[agent-hub] failed to delete session', item, err);
      }
      store.deleteBySessionId(item.agent, item.sessionId);
    }
  });

  ipcMain.handle(IPC.pickDirectory, async () => {
    if (!panel) return null;
    const result = await dialog.showOpenDialog(panel, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.on(IPC.hidePanel, () => {
    panel?.hide();
  });

  ipcMain.handle(IPC.ptySpawn, async (_e, payload: PtySpawnPayload) => {
    if (payload.agent === 'claude' && payload.sessionId && handoff.isSwitching(payload.sessionId)) throw new Error('此会话正在切换到 Codex。');
    if (payload.sessionId) await runner.stopSessionForTerminal(payload.agent, payload.sessionId);
    return attachPty(payload.key, payload.agent, payload.cwd, payload.sessionId);
  });
  ipcMain.on(IPC.ptyWrite, (_e, payload: PtyWritePayload) => {
    if (payload.key.startsWith('claude:') && handoff.isSwitching(payload.key.slice('claude:'.length))) return;
    writePty(payload.key, payload.data);
  });
  ipcMain.on(IPC.ptyResize, (_e, payload: PtyResizePayload) => resizePty(payload.key, payload.cols, payload.rows));
  ipcMain.on(IPC.ptyKill, (_e, key: string) => killPty(key));

  // One subscription for the process's lifetime — see ptyManager.ts's header
  // comment on why this is a broadcast emitter rather than per-attach
  // callbacks.
  ipcMain.handle(IPC.configGetProvider, (_e, agent: AgentKind) =>
    agent === 'codex' ? agentConfig.getCodexProviderConfig() : agentConfig.getClaudeProviderConfig()
  );
  ipcMain.handle(IPC.configSetProvider, (_e, payload: SetProviderConfigPayload) =>
    payload.agent === 'codex'
      ? agentConfig.setCodexProviderConfig(payload)
      : agentConfig.setClaudeProviderConfig(payload)
  );

  ipcMain.handle(IPC.configGetDirTrust, (_e, cwd: string) => agentConfig.getDirTrust(cwd));
  ipcMain.handle(IPC.configTrustDir, (_e, cwd: string) => agentConfig.setDirTrusted(cwd));

  ptyEvents.on('data', (key: string, data: string) => {
    sendToPanel(IPC.ptyOutput, { key, data });
  });
  ptyEvents.on('exit', (key: string, code: number) => {
    sendToPanel(IPC.ptyExit, { key, code });
  });

  runner.on('event', ({ taskId, raw }: { taskId: string; raw: unknown }) => {
    const payload: PushEventPayload = { taskId, raw };
    sendToPanel(IPC.pushEvent, payload);
  });

  runner.on('status', (payload: PushStatusPayload) => {
    sendToPanel(IPC.pushStatus, payload);
  });
}

/** `panel?.webContents.send(...)` only guards against `panel` being `null`
 * — it does NOT guard against the window's native object already being
 * destroyed while the JS variable still references it. During app quit,
 * `before-quit` kills pty/task-runner processes whose exit/data callbacks
 * can fire after (or racing with) the panel's own teardown, which crashed
 * with "Object has been destroyed" on every quit before this check existed. */
function sendToPanel(channel: string, payload: unknown) {
  if (panel && !panel.isDestroyed()) {
    panel.webContents.send(channel, payload);
  }
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  // Must happen before anything can spawn codex/claude — see fixPath.ts.
  await fixPath();

  // A genuinely empty image collapses the Tray's clickable area to 0 width on
  // macOS. Use a real (if invisible) 1x1 transparent PNG so setTitle's emoji
  // is what actually renders.
  const blankIcon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  );
  tray = new Tray(blankIcon);
  tray.setTitle('🤖');
  tray.setToolTip('AgentHub — Codex + Claude Code');

  panel = createPanel();
  registerIpcHandlers();

  tray.on('click', togglePanel);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'AgentHub', enabled: false },
    { type: 'separator' },
    { label: '退出', role: 'quit' },
  ]);
  tray.on('right-click', () => tray?.popUpContextMenu(contextMenu));
});

// Menu bar app: intentionally no 'window-all-closed' handler that calls
// app.quit() — the tray keeps the process alive with no windows open.

app.on('before-quit', () => {
  getRunner().killAll();
  killAllPty();
});
