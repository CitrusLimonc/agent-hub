import type { AgentKind } from '../core/types';

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function claudeToolResultText(content: unknown): string {
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  } else {
    text = JSON.stringify(content ?? '');
  }
  return truncate(text, 800);
}

/** Turns a raw JSONL event from either CLI into one display line, or null to
 * skip it. Live-only events (in-progress command output, streamed text
 * deltas) are handled separately in ConversationView — this only covers
 * "here's a complete new line to show". */
export function formatEvent(agent: AgentKind, raw: any): string | null {
  if (!raw || typeof raw !== 'object') return null;

  if (agent === 'codex') {
    switch (raw.type) {
      case 'item.started': {
        const item = raw.item;
        if (item?.type === 'command_execution') return `⏳ $ ${item.command}`;
        if (item?.type === 'file_change') {
          const paths = (item.changes ?? []).map((c: any) => c.path).join(', ');
          return `⏳ editing: ${paths}`;
        }
        return null;
      }
      case 'item.completed': {
        const item = raw.item;
        if (item?.type === 'agent_message') return item.text;
        if (item?.type === 'command_execution') {
          const output = typeof item.aggregated_output === 'string' ? item.aggregated_output.trim() : '';
          const suffix = output ? `\n${truncate(output, 800)}` : '';
          return `$ ${item.command}  (exit ${item.exit_code ?? '?'})${suffix}`;
        }
        if (item?.type === 'file_change') {
          const paths = (item.changes ?? []).map((c: any) => `${c.kind}: ${c.path}`).join(', ');
          return `✎ ${paths}`;
        }
        if (item?.type === 'error') return `⚠ ${item.message}`;
        return null;
      }
      case 'turn.failed':
        return `❌ turn failed: ${raw.error?.message ?? 'unknown'}`;
      case 'error':
        return `⚠ ${raw.message}`;
      case 'stderr':
        return `[stderr] ${raw.text}`;
      default:
        return null;
    }
  }

  // claude
  switch (raw.type) {
    case 'assistant': {
      const content = raw.message?.content;
      if (!Array.isArray(content)) return null;
      const parts: string[] = [];
      for (const c of content) {
        if (c.type === 'text' && c.text) parts.push(c.text);
        if (c.type === 'tool_use') parts.push(`→ ${c.name}(${truncate(JSON.stringify(c.input), 200)})`);
      }
      return parts.length ? parts.join('\n') : null;
    }
    case 'user': {
      // Tool results come back wrapped in a synthetic "user" turn — without
      // this, the transcript only ever shows what a tool was called with,
      // never what it actually returned.
      const content = raw.message?.content;
      if (!Array.isArray(content)) return null;
      const parts: string[] = [];
      for (const c of content) {
        if (c.type === 'tool_result') {
          const text = claudeToolResultText(c.content);
          parts.push(`${c.is_error ? '⚠' : '→'} ${text}`);
        }
      }
      return parts.length ? parts.join('\n') : null;
    }
    case 'result':
      return raw.is_error ? `❌ failed: ${raw.result ?? raw.subtype}` : `✅ ${raw.result ?? 'done'}`;
    case 'stderr':
      return `[stderr] ${raw.text}`;
    default:
      return null;
  }
}
