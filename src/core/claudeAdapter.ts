import { spawnJsonLineProcess, RunHandle } from './processRunner';

// Claude Code's half of the AgentPlugin interface used by taskRunner.ts —
// mirrors codexAdapter.ts. Claude's `stream-json` schema is the standard
// Anthropic Messages format, so this one's more predictable than Codex's.

/**
 * Headless `-p` runs have no TTY to answer permission prompts. `acceptEdits`
 * auto-approves file edits (Write/Edit) but still gates Bash — a Bash-heavy
 * task will stall in retry/deny loops the way any unanswered prompt does in
 * headless mode (verified empirically). This is a deliberate, narrower choice
 * than `--dangerously-skip-permissions`: safer, at the cost of Bash-dependent
 * tasks not completing unattended. See README "Security tradeoffs".
 */
// `--include-partial-messages` turns on token-level `stream_event` deltas
// (verified empirically — without it, an `assistant` message only arrives
// once fully generated, which feels sluggish next to the interactive CLI).
// ConversationView.tsx is what actually renders these deltas live.
const CLAUDE_BASE_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--permission-mode',
  'acceptEdits',
];

export function launchClaude(cwd: string, prompt: string): RunHandle {
  return spawnJsonLineProcess('claude', [...CLAUDE_BASE_ARGS, prompt], cwd);
}

export function resumeClaude(cwd: string, sessionId: string, prompt: string): RunHandle {
  return spawnJsonLineProcess('claude', [...CLAUDE_BASE_ARGS, '--resume', sessionId, prompt], cwd);
}

/** The `system/init` event carries `session_id`; every later event repeats it too. */
export function extractClaudeSessionId(event: any): string | null {
  if (event && typeof event.session_id === 'string') {
    return event.session_id;
  }
  return null;
}

/** Terminal `{"type":"result", "is_error": true, ...}` is the definitive failure signal. */
export function isClaudeResultFailed(event: any): string | null {
  if (event && event.type === 'result' && event.is_error === true) {
    return event.result ?? event.subtype ?? 'Claude Code run failed (no message)';
  }
  return null;
}

/** Scans backwards for Claude's last text reply — same purpose as
 * codexLastAgentMessage, used as TaskRecord.lastMessage once a task ends. */
export function claudeLastAgentMessage(events: any[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'assistant' && Array.isArray(e.message?.content)) {
      const textBlock = e.message.content.find((c: any) => c?.type === 'text' && typeof c.text === 'string');
      if (textBlock) return textBlock.text;
    }
  }
  return null;
}
