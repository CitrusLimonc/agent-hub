// Shared data model, used by both the Electron main process and the React
// renderer (imported directly by the renderer, and mirrored across IPC via
// src/shared/ipc.ts). Keep this file plain TypeScript — no Node/Electron
// imports — so it stays safe to bundle into the renderer.

export type AgentKind = 'codex' | 'claude';
export type TaskStatus = 'running' | 'needs_attention' | 'succeeded' | 'failed' | 'handed_off' | 'killed';

export interface TaskRecord {
  id: string;
  agent: AgentKind;
  cwd: string;
  prompt: string;
  sessionId: string | null;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  handoffFromTaskId: string | null;
  handoffToTaskId: string | null;
  exitCode: number | null;
  lastMessage: string | null;
}

export interface TaskEventRecord {
  id: number;
  taskId: string;
  ts: number;
  raw: unknown;
}

export interface NewTaskInput {
  agent: AgentKind;
  cwd: string;
  prompt: string;
  autoFailover: boolean;
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  timestamp: string;
  title: string | null;
  /** Unshortened title for hover text; `title` remains the compact label. */
  fullTitle?: string;
  path: string;
  /** File mtime (ISO) — the closest disk signal for "when this session was
   * last touched", since `timestamp` above is the *creation* time parsed
   * from the first line and never changes. A session resumed days later
   * (from AgentHub or straight from a terminal) gets a fresh mtime, which
   * listConversations() uses so recently-active old conversations sort to
   * the top instead of staying buried at their creation date. */
  lastModifiedAt?: string;
  /** Set when this entry stands in for a burst of near-identical sessions
   * collapsed together (see collapseBursts in inspector.ts) — the count of
   * sessions folded into this one, including itself. */
  mergedCount?: number;
}

export type ChatRole = 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  text: string;
  timestamp?: string;
}

export interface ConversationSummary {
  agent: AgentKind;
  sessionId: string;
  cwd: string;
  title: string | null;
  fullTitle?: string;
  /** Epoch milliseconds, null/absent when not pinned. */
  pinnedAt?: number | null;
  /** First message's timestamp — for "created in the last N days" filtering. */
  createdAt: string;
  /** Most recent activity — for sort order and relative-time display. */
  lastActivityAt: string;
  taskId: string | null;
  status: TaskStatus | null;
  /** On-disk session file path, for fetching the transcript. Null only for a
   * conversation AgentHub just started whose session file hasn't been
   * written yet — it has no prior turns to show anyway. */
  path: string | null;
  /** See SessionSummary.mergedCount — carried through for the sidebar to
   * show "×N" on entries standing in for a collapsed automation burst. */
  mergedCount?: number;
}
