import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AgentHubApi,
  type ContinueConversationPayload,
  type CreateTaskPayload,
  type DeleteConversationsPayload,
  type PtyExitPayload,
  type PtyOutputPayload,
  type PtyResizePayload,
  type PtySpawnPayload,
  type PtyWritePayload,
  type PushEventPayload,
  type PushStatusPayload,
  type SetProviderConfigPayload,
  type TranscriptRequest,
} from '../src/shared/ipc';
import type { AgentKind } from '../src/core/types';

// Runs in Electron's sandboxed preload context, which does NOT support
// `require()` of arbitrary project files (only main.ts's regular Node
// process does) — so this file must stay a self-contained bundle. It's built
// with esbuild (see package.json's dev:preload/build:preload scripts), not
// tsc, precisely so its `import`s below get inlined rather than left as
// runtime requires. Learned the hard way: tsc-compiled output here loads
// silently-broken (window.agentHub just never appears) with no error beyond
// a console message sandboxed renderers don't surface by default.

const api: AgentHubApi = {
  listTasks: () => ipcRenderer.invoke(IPC.listTasks),
  createTask: (payload: CreateTaskPayload) => ipcRenderer.invoke(IPC.createTask, payload),
  getEvents: (taskId: string) => ipcRenderer.invoke(IPC.getEvents, taskId),
  getToolsStatus: (agent: AgentKind) => ipcRenderer.invoke(IPC.toolsStatus, agent),
  getToolsSettings: (agent: AgentKind) => ipcRenderer.invoke(IPC.toolsSettings, agent),
  getToolsSkills: (agent: AgentKind) => ipcRenderer.invoke(IPC.toolsSkills, agent),
  listConversations: () => ipcRenderer.invoke(IPC.conversationsList),
  getTranscript: (req: TranscriptRequest) => ipcRenderer.invoke(IPC.conversationsTranscript, req),
  continueConversation: (payload: ContinueConversationPayload) => ipcRenderer.invoke(IPC.conversationsContinue, payload),
  switchToCodex: (payload) => ipcRenderer.invoke(IPC.conversationsSwitchToCodex, payload),
  switchToClaude: (payload) => ipcRenderer.invoke(IPC.conversationsSwitchToClaude, payload),
  setConversationTitle: (payload) => ipcRenderer.invoke(IPC.conversationsSetTitle, payload),
  setConversationPinned: (payload) => ipcRenderer.invoke(IPC.conversationsSetPinned, payload),
  deleteConversations: (payload: DeleteConversationsPayload) => ipcRenderer.invoke(IPC.conversationsDelete, payload),
  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  hidePanel: () => ipcRenderer.send(IPC.hidePanel),
  spawnPty: (payload: PtySpawnPayload) => ipcRenderer.invoke(IPC.ptySpawn, payload),
  writePty: (payload: PtyWritePayload) => ipcRenderer.send(IPC.ptyWrite, payload),
  resizePty: (payload: PtyResizePayload) => ipcRenderer.send(IPC.ptyResize, payload),
  killPty: (key: string) => ipcRenderer.send(IPC.ptyKill, key),
  onPtyOutput(cb: (payload: PtyOutputPayload) => void) {
    const listener = (_e: Electron.IpcRendererEvent, payload: PtyOutputPayload) => cb(payload);
    ipcRenderer.on(IPC.ptyOutput, listener);
    return () => ipcRenderer.removeListener(IPC.ptyOutput, listener);
  },
  onPtyExit(cb: (payload: PtyExitPayload) => void) {
    const listener = (_e: Electron.IpcRendererEvent, payload: PtyExitPayload) => cb(payload);
    ipcRenderer.on(IPC.ptyExit, listener);
    return () => ipcRenderer.removeListener(IPC.ptyExit, listener);
  },
  onEvent(cb: (payload: PushEventPayload) => void) {
    const listener = (_e: Electron.IpcRendererEvent, payload: PushEventPayload) => cb(payload);
    ipcRenderer.on(IPC.pushEvent, listener);
    return () => ipcRenderer.removeListener(IPC.pushEvent, listener);
  },
  onStatus(cb: (payload: PushStatusPayload) => void) {
    const listener = (_e: Electron.IpcRendererEvent, payload: PushStatusPayload) => cb(payload);
    ipcRenderer.on(IPC.pushStatus, listener);
    return () => ipcRenderer.removeListener(IPC.pushStatus, listener);
  },
  getProviderConfig: (agent: AgentKind) => ipcRenderer.invoke(IPC.configGetProvider, agent),
  setProviderConfig: (payload: SetProviderConfigPayload) => ipcRenderer.invoke(IPC.configSetProvider, payload),
  getDirTrust: (cwd: string) => ipcRenderer.invoke(IPC.configGetDirTrust, cwd),
  trustDir: (cwd: string) => ipcRenderer.invoke(IPC.configTrustDir, cwd),
};

contextBridge.exposeInMainWorld('agentHub', api);
