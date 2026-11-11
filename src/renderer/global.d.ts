import type { AgentHubApi } from '../shared/ipc';

declare global {
  interface Window {
    agentHub: AgentHubApi;
  }
}

export {};
