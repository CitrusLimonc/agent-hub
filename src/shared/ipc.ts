import type {
  AgentKind,
  ChatMessage,
  ConversationSummary,
  SkillInfo,
  TaskEventRecord,
  TaskRecord,
  TaskStatus,
} from '../core/types';

// The IPC contract between main.ts (implements each handler) and preload.ts
// (implements AgentHubApi by forwarding to these channels) — the renderer
// only ever sees `window.agentHub`, never these channel names directly.
// Keep channel names and payload shapes here so both sides can't drift.

export const IPC = {
  listTasks: 'tasks:list',
  createTask: 'tasks:create',
  getEvents: 'tasks:events',
  pushEvent: 'tasks:event',
  pushStatus: 'tasks:status',
  toolsStatus: 'tools:status',
  toolsSettings: 'tools:settings',
  toolsSkills: 'tools:skills',
  conversationsList: 'conversations:list',
  conversationsTranscript: 'conversations:transcript',
  conversationsContinue: 'conversations:continue',
  conversationsSwitchToCodex: 'conversations:switchToCodex',
  conversationsSwitchToClaude: 'conversations:switchToClaude',
  conversationsSetTitle: 'conversations:setTitle',
  conversationsSetPinned: 'conversations:setPinned',
  conversationsDelete: 'conversations:delete',
  pickDirectory: 'dialog:pickDirectory',
  hidePanel: 'panel:hide',
  ptySpawn: 'pty:spawn',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyOutput: 'pty:output',
  ptyExit: 'pty:exit',
  ptyKill: 'pty:kill',
  configGetProvider: 'config:getProvider',
  configSetProvider: 'config:setProvider',
  configGetDirTrust: 'config:getDirTrust',
  configTrustDir: 'config:trustDir',
} as const;

export interface CreateTaskPayload {
  agent: AgentKind;
  cwd: string;
  prompt: string;
}

export interface ContinueConversationPayload {
  agent: AgentKind;
  cwd: string;
  sessionId: string;
  message: string;
}

export interface TranscriptRequest {
  agent: AgentKind;
  path: string;
}

export interface SwitchToCodexPayload {
  sessionId: string;
  path: string;
  cwd: string;
  instruction: string;
}

export interface SwitchToCodexResult {
  task: TaskRecord;
  title: string;
  contextPath: string;
  entryCount: number;
  memoryFileCount: number;
  skippedLines: number;
}

export type SwitchToClaudePayload = SwitchToCodexPayload;
export type SwitchToClaudeResult = SwitchToCodexResult;

export interface SetConversationTitlePayload {
  agent: AgentKind;
  sessionId: string;
  /** Empty/null restores the CLI's original title. */
  title: string | null;
}

export interface SetConversationPinnedPayload {
  agent: AgentKind;
  sessionId: string;
  pinned: boolean;
  path: string | null;
}

export interface DeleteConversationsPayload {
  items: Array<{ agent: AgentKind; sessionId: string; path: string | null }>;
}

export interface PtySpawnPayload {
  key: string;
  agent: AgentKind;
  cwd: string;
  sessionId: string | null;
}

export interface PtyWritePayload {
  key: string;
  data: string;
}

export interface PtyResizePayload {
  key: string;
  cols: number;
  rows: number;
}

export interface PtyOutputPayload {
  key: string;
  data: string;
}

export interface PtyExitPayload {
  key: string;
  code: number;
}

/** `baseUrl: null` means "no custom endpoint configured" (official API);
 * `hasApiKey` is a presence flag only — the actual key is never sent to the
 * renderer, see agentConfig.ts. */
export interface ProviderConfig {
  baseUrl: string | null;
  hasApiKey: boolean;
}

export interface SetProviderConfigPayload {
  agent: AgentKind;
  baseUrl?: string;
  apiKey?: string;
}

/** See agentConfig.ts's DirTrustStatus — whether each CLI trusts a cwd. */
export interface DirTrustStatus {
  codex: boolean;
  claude: boolean;
}

export interface PushEventPayload {
  taskId: string;
  raw: unknown;
}

export interface PushStatusPayload {
  taskId: string;
  agent: AgentKind;
  status: TaskStatus;
  message?: string;
}

export interface AgentHubApi {
  listTasks(): Promise<TaskRecord[]>;
  createTask(payload: CreateTaskPayload): Promise<TaskRecord>;
  getEvents(taskId: string): Promise<TaskEventRecord[]>;
  onEvent(cb: (payload: PushEventPayload) => void): () => void;
  onStatus(cb: (payload: PushStatusPayload) => void): () => void;
  getToolsStatus(agent: AgentKind): Promise<string>;
  getToolsSettings(agent: AgentKind): Promise<string>;
  getToolsSkills(agent: AgentKind): Promise<SkillInfo[]>;
  listConversations(): Promise<ConversationSummary[]>;
  getTranscript(req: TranscriptRequest): Promise<ChatMessage[]>;
  continueConversation(payload: ContinueConversationPayload): Promise<TaskRecord>;
  switchToCodex(payload: SwitchToCodexPayload): Promise<SwitchToCodexResult>;
  switchToClaude(payload: SwitchToClaudePayload): Promise<SwitchToClaudeResult>;
  setConversationTitle(payload: SetConversationTitlePayload): Promise<string | null>;
  setConversationPinned(payload: SetConversationPinnedPayload): Promise<void>;
  deleteConversations(payload: DeleteConversationsPayload): Promise<void>;
  pickDirectory(): Promise<string | null>;
  hidePanel(): void;
  spawnPty(payload: PtySpawnPayload): Promise<string>;
  writePty(payload: PtyWritePayload): void;
  resizePty(payload: PtyResizePayload): void;
  /** Kills one pty session by key. Used when navigating away from a
   * brand-new terminal conversation (empty sessionId) — its optimistic key
   * is unreachable from the UI after that, so the process would otherwise
   * leak until app quit. No-op if no session exists under the key. */
  killPty(key: string): void;
  onPtyOutput(cb: (payload: PtyOutputPayload) => void): () => void;
  onPtyExit(cb: (payload: PtyExitPayload) => void): () => void;
  getProviderConfig(agent: AgentKind): Promise<ProviderConfig>;
  setProviderConfig(payload: SetProviderConfigPayload): Promise<void>;
  getDirTrust(cwd: string): Promise<DirTrustStatus>;
  /** Explicit user action (the "信任此目录" button) — marks cwd trusted for
   * both CLIs, activating its local permission whitelists. */
  trustDir(cwd: string): Promise<DirTrustStatus>;
}
