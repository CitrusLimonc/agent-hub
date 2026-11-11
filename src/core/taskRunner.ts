import { EventEmitter } from 'node:events';
import type { TaskStore } from './taskStore';
import {
  launchCodex,
  resumeCodex,
  extractCodexSessionId,
  isCodexTurnFailed,
  codexLastAgentMessage,
} from './codexAdapter';
import {
  launchClaude,
  resumeClaude,
  extractClaudeSessionId,
  isClaudeResultFailed,
  claudeLastAgentMessage,
} from './claudeAdapter';
import { createStallWatcher, DEFAULT_STALL_TIMEOUT_MS, type StallWatcher } from './failureDetector';
import { detectAttention } from './attentionDetector';
import type { RunHandle } from './processRunner';
import type { AgentKind, TaskRecord, TaskStatus } from './types';

// Everything this runner needs to know about an agent CLI, so `start`/`resume`
// /`wire`/`finish` below can stay agent-agnostic. Each side's actual spawn
// args and event-shape quirks live in codexAdapter.ts / claudeAdapter.ts.
interface AgentPlugin {
  launch(cwd: string, prompt: string): RunHandle;
  resume(cwd: string, sessionId: string, prompt: string): RunHandle;
  extractSessionId(event: any): string | null;
  isFailed(event: any): string | null;
  lastAgentMessage(events: any[]): string | null;
}

const PLUGINS: Record<AgentKind, AgentPlugin> = {
  codex: {
    launch: launchCodex,
    resume: resumeCodex,
    extractSessionId: extractCodexSessionId,
    isFailed: isCodexTurnFailed,
    lastAgentMessage: codexLastAgentMessage,
  },
  claude: {
    launch: launchClaude,
    resume: resumeClaude,
    extractSessionId: extractClaudeSessionId,
    isFailed: isClaudeResultFailed,
    lastAgentMessage: claudeLastAgentMessage,
  },
};

export interface TaskStatusEvent {
  taskId: string;
  agent: AgentKind;
  status: TaskStatus;
  message?: string;
}

/**
 * Spawns and monitors codex/claude tasks. Emits `event` for every raw JSONL
 * line (UI live log) and `status` exactly once per task when it reaches a
 * terminal state (succeeded/failed). Does not know about failover — see
 * failoverController.ts, which subscribes to `status`.
 */
export class TaskRunner extends EventEmitter {
  private eventsByTask = new Map<string, unknown[]>();
  private stallWatchers = new Map<string, StallWatcher>();
  private handledTerminal = new Set<string>();
  private handlesByTask = new Map<string, RunHandle>();
  private exitsByTask = new Map<string, Promise<void>>();
  private terminalTakeovers = new Map<string, Promise<void>>();

  constructor(
    private store: TaskStore,
    private stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS
  ) {
    super();
  }

  start(agent: AgentKind, cwd: string, prompt: string, opts?: { handoffFromTaskId?: string }): TaskRecord {
    const task = this.store.createTask({ agent, cwd, prompt, autoFailover: agent === 'codex' });
    if (opts?.handoffFromTaskId) this.store.linkHandoff(opts.handoffFromTaskId, task.id);
    const plugin = PLUGINS[agent];
    const handle = plugin.launch(cwd, prompt);
    this.handlesByTask.set(task.id, handle);
    this.wire(task.id, agent, plugin, handle);
    return task;
  }

  /** Continues an existing conversation. Both CLIs are one-shot processes —
   * there's no "send another message to a still-running process"; every new
   * turn is its own `resume <sessionId> "<msg>"` spawn. */
  resume(agent: AgentKind, cwd: string, sessionId: string, prompt: string): TaskRecord {
    if (this.terminalTakeovers.has(`${agent}:${sessionId}`)) throw new Error('此会话正在切换到终端。');
    if (this.isSessionRunning(agent, sessionId)) throw new Error('此会话仍在运行，请等待当前任务结束。');
    const task = this.store.createTask({ agent, cwd, prompt, autoFailover: agent === 'codex' });
    this.store.setSessionId(task.id, sessionId);
    const plugin = PLUGINS[agent];
    const handle = plugin.resume(cwd, sessionId, prompt);
    this.handlesByTask.set(task.id, handle);
    this.wire(task.id, agent, plugin, handle);
    return { ...task, sessionId };
  }

  getEvents(taskId: string): unknown[] {
    return this.eventsByTask.get(taskId) ?? [];
  }

  isSessionRunning(agent: AgentKind, sessionId: string): boolean {
    for (const taskId of this.handlesByTask.keys()) {
      const task = this.store.getTask(taskId);
      if (task?.agent === agent && task.sessionId === sessionId) return true;
    }
    return false;
  }

  /** A user can take over a running headless turn in the terminal. Wait
   * for actual process exit before resuming the same session, and classify
   * the interruption as killed so it never triggers automatic failover. */
  stopSessionForTerminal(agent: AgentKind, sessionId: string): Promise<void> {
    const key = `${agent}:${sessionId}`;
    const existing = this.terminalTakeovers.get(key);
    if (existing) return existing;
    const stop = async () => {
      for (const [taskId, handle] of this.handlesByTask) {
        const task = this.store.getTask(taskId);
        if (task?.agent !== agent || task.sessionId !== sessionId) continue;
        const wasActive = !this.handledTerminal.has(taskId);
        this.handledTerminal.add(taskId);
        this.stallWatchers.get(taskId)?.stop();
        const exited = this.exitsByTask.get(taskId)!;
        handle.kill();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exited,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('后台进程尚未退出，未打开终端。请稍后重试。')), 8000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (wasActive) {
          this.store.updateStatus(taskId, 'killed');
          this.emit('status', { taskId, agent, status: 'killed', message: '已停止后台执行，转到终端继续。' } satisfies TaskStatusEvent);
        }
      }
    };
    const pending = stop().finally(() => this.terminalTakeovers.delete(key));
    this.terminalTakeovers.set(key, pending);
    return pending;
  }

  /** Kills every still-running child process. Call this on app quit — Codex/
   * Claude Code subprocesses are not `detached`, but Node does not auto-kill
   * non-detached children when the parent exits, so without this they'd keep
   * running (and burning API calls) as orphans after the app closes. */
  killAll() {
    for (const [taskId, handle] of this.handlesByTask) {
      if (!this.handledTerminal.has(taskId)) {
        handle.kill();
      }
    }
  }

  private wire(taskId: string, agent: AgentKind, plugin: AgentPlugin, handle: RunHandle) {
    let resolveExit!: () => void;
    this.exitsByTask.set(taskId, new Promise<void>((resolve) => { resolveExit = resolve; }));
    this.eventsByTask.set(taskId, []);
    const watcher = createStallWatcher(this.stallTimeoutMs, () => {
      this.finish(taskId, agent, plugin, 'failed', `没有输出超过 ${Math.round(this.stallTimeoutMs / 1000)}s,判定为卡住`);
      handle.kill();
    });
    this.stallWatchers.set(taskId, watcher);

    handle.onEvent((raw: any) => {
      this.eventsByTask.get(taskId)!.push(raw);
      this.store.appendEvent(taskId, raw);
      watcher.touch();

      const sessionId = plugin.extractSessionId(raw);
      if (sessionId) this.store.setSessionId(taskId, sessionId);

      this.emit('event', { taskId, raw });

      const failMsg = plugin.isFailed(raw);
      if (failMsg) {
        this.finish(taskId, agent, plugin, 'failed', failMsg);
        return;
      }

      // Transient "agent probably needs a human" hint: a tool call was just
      // denied/blocked. Flip the (still-running) task to needs_attention so
      // the sidebar lights up; the next event — the agent recovering on its
      // own, or the process finishing — flips it back via the same mechanism
      // (status events carry the full status every time, see pushStatus).
      if (this.handledTerminal.has(taskId)) return;
      const attention = detectAttention(agent, raw);
      if (attention) {
        this.store.updateStatus(taskId, 'needs_attention', null);
        this.emit('status', { taskId, agent, status: 'needs_attention', message: attention } satisfies TaskStatusEvent);
      }
    });

    handle.onExit((code) => {
      this.handlesByTask.delete(taskId);
      this.exitsByTask.delete(taskId);
      resolveExit();
      if (this.handledTerminal.has(taskId)) return;
      const status: TaskStatus = code === 0 ? 'succeeded' : 'failed';
      this.finish(taskId, agent, plugin, status, status === 'failed' ? `进程退出码 ${code}` : undefined, code);
    });
  }

  private finish(
    taskId: string,
    agent: AgentKind,
    plugin: AgentPlugin,
    status: TaskStatus,
    message?: string,
    exitCode?: number | null
  ) {
    if (this.handledTerminal.has(taskId)) return;
    this.handledTerminal.add(taskId);
    this.stallWatchers.get(taskId)?.stop();

    const events = this.eventsByTask.get(taskId) ?? [];
    const lastMsg = plugin.lastAgentMessage(events as any[]);
    if (lastMsg) this.store.setLastMessage(taskId, lastMsg);
    // Terminal states always overwrite a lingering needs_attention.
    this.store.updateStatus(taskId, status, exitCode ?? null);

    const evt: TaskStatusEvent = { taskId, agent, status, message };
    this.emit('status', evt);
  }
}
