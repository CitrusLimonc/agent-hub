import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import type { AgentKind } from './types';

// Runs the CLIs' real interactive TUIs (not the `--json`/`-p` headless mode
// used by taskRunner.ts) inside a pseudo-terminal, for the "just like typing
// it myself" terminal mode. Deliberately outside taskStore/TaskRunner: an
// interactive process is open-ended (no "finished" state, might sit waiting
// on a prompt indefinitely), and forcing it through the one-shot task model
// would confuse the "running" status the sidebar shows for headless tasks.
//
// Sessions are keyed by the same `agent:sessionId` string ConversationSidebar
// uses (conversationKey) and persist in this module-level Map across
// renderer-side mode toggles — closing the terminal view does NOT kill the
// process, only killAllPty() (called on app quit) does. node-pty has no
// scrollback replay of its own, so each session also keeps a capped output
// buffer here to replay into a freshly (re)mounted xterm.js instance.
//
// Output/exit are broadcast via `ptyEvents` (one process-wide emitter) rather
// than per-attach callbacks: there's only ever one panel window, so main.ts
// subscribes exactly once at startup and forwards everything over IPC keyed
// by session key. A per-attach-callback design would need explicit
// detach/cleanup on every mode-toggle to avoid duplicate forwarding — this
// sidesteps that entirely.

const MAX_BUFFER_BYTES = 200_000;

/** Identity vars a *parent* claude/codex process exports for its children.
 * If AgentHub itself was launched from inside one of those sessions (dev
 * mode from a terminal running claude, say), blindly forwarding
 * process.env makes the spawned CLI believe it's a child session of that
 * parent — and a claude started with CLAUDE_CODE_SESSION_ID set silently
 * writes NO session file of its own (verified: with the vars stripped the
 * jsonl appears instantly, without them it never lands). Strip them so
 * every spawned CLI is always a fresh top-level session. */
function childEnv(): { [key: string]: string } {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CODE_CHILD_SESSION;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_EXECPATH;
  return env as { [key: string]: string };
}

interface PtySessionEntry {
  proc: pty.IPty;
  buffer: string;
  exited: Promise<void>;
  closing: boolean;
}

const sessions = new Map<string, PtySessionEntry>();

export const ptyEvents = new EventEmitter();

function commandFor(agent: AgentKind, sessionId: string | null): { cmd: string; args: string[] } {
  if (agent === 'codex') {
    return sessionId ? { cmd: 'codex', args: ['resume', sessionId] } : { cmd: 'codex', args: [] };
  }
  return sessionId ? { cmd: 'claude', args: ['--resume', sessionId] } : { cmd: 'claude', args: [] };
}

/** Spawns a new interactive session under `key`, or no-ops if one's already
 * running there. Either way, returns what's buffered so far so the caller
 * can replay it into a (re)mounted xterm.js instance. */
export function attachPty(key: string, agent: AgentKind, cwd: string, sessionId: string | null): string {
  let entry = sessions.get(key);
  if (entry?.closing) throw new Error('此终端正在关闭，请稍后重试。');
  if (!entry) {
    const { cmd, args } = commandFor(agent, sessionId);
    const proc = pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: childEnv(),
    });

    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    entry = { proc, buffer: '', exited, closing: false };
    sessions.set(key, entry);

    proc.onData((data) => {
      entry!.buffer = (entry!.buffer + data).slice(-MAX_BUFFER_BYTES);
      ptyEvents.emit('data', key, data);
    });
    proc.onExit(({ exitCode }) => {
      resolveExit();
      ptyEvents.emit('exit', key, exitCode);
      if (sessions.get(key) === entry) sessions.delete(key);
    });
  }
  return entry.buffer;
}

export function writePty(key: string, data: string) {
  const entry = sessions.get(key);
  if (entry && !entry.closing) entry.proc.write(data);
}

export function resizePty(key: string, cols: number, rows: number) {
  sessions.get(key)?.proc.resize(cols, rows);
}

export function killPty(key: string) {
  sessions.get(key)?.proc.kill();
  sessions.delete(key);
}

/** Wait for the source terminal to stop before taking its final snapshot.
 * Unlike killPty, keep its key reserved until the process actually exits. */
export async function stopPty(key: string): Promise<void> {
  const entry = sessions.get(key);
  if (!entry) return;
  entry.closing = true;
  entry.proc.kill();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entry.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Claude 终端尚未退出，未启动 Codex。请退出终端后重试。')), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function killAllPty() {
  for (const entry of sessions.values()) entry.proc.kill();
  sessions.clear();
}
