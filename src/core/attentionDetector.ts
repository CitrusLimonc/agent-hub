// Detects "the agent hit something that probably needs a human decision"
// moments in the headless event streams. Neither CLI actually *waits* for a
// user in headless mode (verified: codex exec reports permission failures as
// plain text and completes the turn; claude -p with --permission-mode
// acceptEdits auto-denies unapproved Bash calls and moves on) — so "needs
// attention" means "a tool call was just denied/blocked/failed", surfaced as
// a transient sidebar hint while the task is still running, not a hard
// paused state.

/** Returns a short human-readable reason if this raw event looks like a
 * denied/blocked tool call, else null. Both agents' shapes covered:
 * - claude: `user` messages carrying `tool_result` blocks with is_error, or
 *   denial text ("requires approval" / "was blocked")
 * - codex: `item.completed` items of type `error`, or command_execution
 *   output containing permission-denial text */
export function detectAttention(agent: 'codex' | 'claude', raw: any): string | null {
  if (agent === 'claude') return detectClaude(raw);
  return detectCodex(raw);
}

function detectClaude(raw: any): string | null {
  if (raw?.type !== 'user') return null;
  const content = raw.message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block?.type !== 'tool_result') continue;
    const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
    if (block.is_error || /requires approval|was blocked|permission (denied|required)/i.test(text)) {
      return firstLine(text) || '工具调用被拒绝';
    }
  }
  return null;
}

function detectCodex(raw: any): string | null {
  if (raw?.type !== 'item.completed') return null;
  const item = raw.item;
  if (!item) return null;
  if (item.type === 'error') return firstLine(item.message ?? '') || '执行出错';
  if (item.type === 'command_execution') {
    const out = `${item.aggregated_output ?? ''}`;
    if (/operation not permitted|permission denied|requires approval/i.test(out)) {
      return firstLine(out) || '命令被拒绝';
    }
  }
  return null;
}

function firstLine(text: string): string | null {
  const line = String(text).split('\n').find((l) => l.trim());
  return line ? (line.length > 120 ? `${line.slice(0, 120)}…` : line) : null;
}
