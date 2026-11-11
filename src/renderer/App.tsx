import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentKind, ConversationSummary } from '../core/types';
import ConversationSidebar, { conversationKey } from './ConversationSidebar';
import ConversationView, { rememberedMode } from './ConversationView';
import NewTaskForm from './NewTaskForm';
import ToolsView from './ToolsView';
import type { SwitchToCodexResult, SwitchToClaudeResult } from '../shared/ipc';

type ViewMode = 'chat' | 'tools';
type Theme = 'dark' | 'light';

const THEME_STORAGE_KEY = 'agenthub-theme';

function readInitialTheme(): Theme {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// Top-level layout: a sidebar of every conversation (ConversationSidebar) +
// either the selected one (ConversationView) or the "start a new one" form
// (NewTaskForm) — or the whole thing swapped out for ToolsView. `selected`
// starts as an "optimistic" ConversationSummary built from just-returned
// TaskRecord fields (see handleCreate) before the real session file exists
// on disk; selectedTaskIdRef lets the onStatus listener below know which
// task to watch for so it can swap in the real, disk-backed summary once
// that first turn finishes (see ConversationSidebar's status icon).
export default function App() {
  const [view, setView] = useState<ViewMode>('chat');
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<ConversationSummary | null>(null);
  const [initialConvMode, setInitialConvMode] = useState<'chat' | 'terminal'>('chat');
  const [handoffNotice, setHandoffNotice] = useState('');
  const selectedTaskIdRef = useRef<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const refreshConversations = useCallback(async () => {
    const list = await window.agentHub.listConversations();
    setConversations(list);
    return list;
  }, []);

  useEffect(() => {
    refreshConversations();

    const offStatus = window.agentHub.onStatus(async ({ taskId }) => {
      const list = await refreshConversations();
      if (selectedTaskIdRef.current === taskId) {
        const updated = list.find((c) => c.taskId === taskId);
        if (updated) setSelected(updated);
      }
    });

    // A newly created handoff starts without a session ID. Refresh as soon
    // as the CLI announces it, so terminal resume is available immediately.
    const offEvent = window.agentHub.onEvent(async ({ taskId, raw }) => {
      const event = raw as { type?: string; subtype?: string };
      if (event?.type !== 'thread.started' && !(event?.type === 'system' && event.subtype === 'init')) return;
      const list = await refreshConversations();
      if (selectedTaskIdRef.current === taskId) {
        const updated = list.find((c) => c.taskId === taskId);
        if (updated) setSelected(updated);
      }
    });

    return () => { offStatus(); offEvent(); };
  }, [refreshConversations]);

  // Navigating away from a brand-new terminal conversation (the optimistic
  // "在终端中打开" entry with empty sessionId) must kill its pty: the entry
  // exists only in `selected` state and never enters the sidebar, so once
  // navigation replaces it there is no UI path back to that pty key — the
  // process would leak until app quit, and a later terminal-mode open of the
  // real (disk-discovered) session would spawn a *second* interactive
  // process on the same session file. For conversations with a real
  // sessionId this is a no-op (they keep the deliberate keep-alive behavior;
  // no pty exists under a headless task's key either).
  const abandonSelectedTerminal = () => {
    if (selected && !selected.sessionId) {
      window.agentHub.killPty(conversationKey(selected));
    }
  };

  const selectConversation = (c: ConversationSummary) => {
    setHandoffNotice('');
    abandonSelectedTerminal();
    selectedTaskIdRef.current = c.taskId;
    // Reopen in whatever mode (chat/terminal) the user last used for this
    // specific conversation — see rememberedMode in ConversationView.tsx.
    setInitialConvMode(rememberedMode(c));
    setSelected(c);
    // PTY-created sessions never trigger onStatus (the only other refresh
    // trigger), so the sidebar list goes stale while a terminal conversation
    // runs — refresh on every navigation so newly-written disk sessions
    // (including ones started from "在终端中打开") actually show up.
    refreshConversations();
  };

  const startNew = () => {
    setHandoffNotice('');
    abandonSelectedTerminal();
    selectedTaskIdRef.current = null;
    setSelected(null);
    refreshConversations();
  };

  // "在终端中打开" — no headless task, no taskId from the backend, so
  // conversationKey needs *some* unique fallback (it's `agent:sessionId ||
  // taskId`) until the real session shows up via a later disk scan.
  const handleOpenTerminal = (agent: AgentKind, cwd: string) => {
    setHandoffNotice('');
    abandonSelectedTerminal();
    const optimistic: ConversationSummary = {
      agent,
      sessionId: '',
      cwd,
      title: '新终端会话',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      taskId: crypto.randomUUID(),
      status: null,
      path: null,
    };
    selectedTaskIdRef.current = null;
    setInitialConvMode('terminal');
    setSelected(optimistic);
    setConversations((prev) => [optimistic, ...prev]);
    // The CLI writes its real session file shortly after the pty starts (at
    // latest on the first exchanged message) — pick it up into the sidebar
    // with a delayed refresh so the entry exists *before* the user navigates
    // away, not only after. No onStatus will ever fire for a pty session.
    setTimeout(() => refreshConversations(), 3000);
  };

  const handleDeleted = async (deletedKeys: string[]) => {
    await refreshConversations();
    if (selected && deletedKeys.includes(conversationKey(selected))) {
      selectedTaskIdRef.current = null;
      setSelected(null);
    }
  };

  const handleCreate = async (agent: AgentKind, cwd: string, prompt: string) => {
    setHandoffNotice('');
    abandonSelectedTerminal();
    const task = await window.agentHub.createTask({ agent, cwd, prompt });
    const optimistic: ConversationSummary = {
      agent,
      sessionId: task.sessionId ?? '',
      cwd,
      title: prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      taskId: task.id,
      status: 'running',
      path: null,
    };
    selectedTaskIdRef.current = task.id;
    setInitialConvMode('chat');
    setSelected(optimistic);
  };

  const handleSwitchToCodex = (result: SwitchToCodexResult) => {
    const { task } = result;
    selectedTaskIdRef.current = task.id;
    setInitialConvMode('chat');
    setHandoffNotice(`已交接 ${result.entryCount} 条历史记录、${result.memoryFileCount} 个项目记忆文件。${result.skippedLines ? `有 ${result.skippedLines} 行记录无法解析，已跳过。` : ''}`);
    const optimistic: ConversationSummary = {
      agent: 'codex', sessionId: task.sessionId ?? '', cwd: task.cwd, title: result.title,
      createdAt: new Date(task.createdAt).toISOString(), lastActivityAt: new Date(task.updatedAt).toISOString(),
      taskId: task.id, status: task.status, path: null,
    };
    setSelected(optimistic);
    // Include the task immediately, before the CLI emits its session ID.
    setConversations((prev) => [optimistic, ...prev]);
    refreshConversations().then((list) => {
      if (selectedTaskIdRef.current !== task.id) return;
      const updated = list.find((c) => c.taskId === task.id);
      if (updated) setSelected(updated);
    }).catch(() => { /* The optimistic conversation remains usable. */ });
  };

  const handleSwitchToClaude = (result: SwitchToClaudeResult) => {
    const { task } = result;
    selectedTaskIdRef.current = task.id;
    setInitialConvMode('chat');
    setHandoffNotice(`已交接 ${result.entryCount} 条历史记录。${result.skippedLines ? `有 ${result.skippedLines} 行记录无法解析，已跳过。` : ''}`);
    const optimistic: ConversationSummary = {
      agent: 'claude', sessionId: task.sessionId ?? '', cwd: task.cwd, title: result.title,
      createdAt: new Date(task.createdAt).toISOString(), lastActivityAt: new Date(task.updatedAt).toISOString(),
      taskId: task.id, status: task.status, path: null,
    };
    setSelected(optimistic);
    setConversations((prev) => [optimistic, ...prev]);
    refreshConversations().then((list) => {
      if (selectedTaskIdRef.current !== task.id) return;
      const updated = list.find((c) => c.taskId === task.id);
      if (updated) setSelected(updated);
    }).catch(() => { /* The optimistic conversation remains usable. */ });
  };

  return (
    <div className="panel">
      <header className="panel-header">
        <span className="panel-title">AgentHub</span>
        <div className="header-actions">
          <button
            className="theme-toggle-btn"
            title="切换亮/暗主题"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? '🌙' : '☀️'}
          </button>
          <button className="icon-btn" onClick={() => setView((v) => (v === 'tools' ? 'chat' : 'tools'))}>
            {view === 'tools' ? '← 返回对话' : '⚙ 工具'}
          </button>
          <button className="theme-toggle-btn close-btn" title="关闭面板" onClick={() => window.agentHub.hidePanel()}>
            ✕
          </button>
        </div>
      </header>

      <div className={`panel-body ${view === 'chat' ? 'panel-body-split' : ''}`}>
        {view === 'tools' ? (
          <ToolsView />
        ) : (
          <>
            <ConversationSidebar
              conversations={conversations}
              selectedKey={selected ? conversationKey(selected) : null}
              onSelect={selectConversation}
              onNew={startNew}
              onDeleted={handleDeleted}
              onRenamed={async () => {
                const list = await refreshConversations();
                setSelected((current) => current ? list.find((c) => conversationKey(c) === conversationKey(current)) ?? current : null);
              }}
            />
            <div className="conv-pane">
              {selected ? (
                <ConversationView
                  key={conversationKey(selected)}
                  conversation={selected}
                  initialMode={initialConvMode}
                  theme={theme}
                  onSwitchToCodex={handleSwitchToCodex}
                  onSwitchToClaude={handleSwitchToClaude}
                  handoffNotice={handoffNotice}
                />
              ) : (
                <NewTaskForm onSubmit={handleCreate} onOpenTerminal={handleOpenTerminal} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
