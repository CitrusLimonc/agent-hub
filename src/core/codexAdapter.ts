import { spawnJsonLineProcess, RunHandle } from './processRunner';

// Codex-specific half of the AgentPlugin interface used by taskRunner.ts —
// how to spawn it, and how to read its `--json` event stream. All the
// spawn-arg and schema quirks below were found by trial against a real
// `codex` binary, not from documentation (see README).

export function launchCodex(cwd: string, prompt: string): RunHandle {
  return spawnJsonLineProcess(
    'codex',
    ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '--cd', cwd, prompt],
    cwd
  );
}

/** `codex exec resume` doesn't accept `-s`/`--cd` — it inherits the sandbox
 * mode and working directory from the session being resumed. */
export function resumeCodex(cwd: string, sessionId: string, prompt: string): RunHandle {
  return spawnJsonLineProcess('codex', ['exec', 'resume', sessionId, '--json', '--skip-git-repo-check', prompt], cwd);
}

/** `{"type":"thread.started","thread_id":"..."}` — first event of every run. */
export function extractCodexSessionId(event: any): string | null {
  if (event && event.type === 'thread.started' && typeof event.thread_id === 'string') {
    return event.thread_id;
  }
  return null;
}

/**
 * Codex retries transient errors internally (rate limits etc. show up as
 * `{"type":"error","message":"Reconnecting... N/5 ..."}` and often self-heal).
 * The only definitive "this turn is dead" signal is `turn.failed`.
 */
export function isCodexTurnFailed(event: any): string | null {
  if (event && event.type === 'turn.failed') {
    return event.error?.message ?? 'Codex turn failed (no message)';
  }
  return null;
}

/** Scans backwards for the last thing Codex actually said, used as the
 * task's one-line summary once it finishes (see TaskRecord.lastMessage). */
export function codexLastAgentMessage(events: any[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') {
      return e.item.text;
    }
  }
  return null;
}
