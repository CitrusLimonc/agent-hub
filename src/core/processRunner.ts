import { spawn } from 'node:child_process';
import readline from 'node:readline';

export interface RunHandle {
  pid: number | undefined;
  onEvent(cb: (raw: unknown) => void): void;
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(): void;
}

/**
 * Spawns a CLI that emits one JSON object per line on stdout (Codex `--json`,
 * Claude Code `--output-format stream-json`). Lines that aren't valid JSON are
 * wrapped so nothing is silently dropped. stdin is closed — both CLIs will try
 * to read from stdin if it looks piped/open, which hangs a headless spawn.
 */
export function spawnJsonLineProcess(cmd: string, args: string[], cwd: string): RunHandle {
  // Identity vars stripped for the same reason as ptyManager.childEnv() — a
  // parent claude session's CLAUDE_CODE_SESSION_ID etc. must not leak into
  // the headless child (would make it write into the parent's session or
  // nowhere at all instead of its own file).
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CODE_CHILD_SESSION;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_EXECPATH;
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const eventCbs: Array<(raw: unknown) => void> = [];
  const exitCbs: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = { type: 'raw_text', text: trimmed };
    }
    eventCbs.forEach((cb) => cb(parsed));
  });

  const errRl = readline.createInterface({ input: child.stderr });
  errRl.on('line', (line) => {
    if (!line.trim()) return;
    eventCbs.forEach((cb) => cb({ type: 'stderr', text: line }));
  });

  // close comes after stdout/stderr drain; a terminal takeover must wait
  // until the final events have been persisted before resuming the session.
  child.on('close', (code, signal) => {
    exitCbs.forEach((cb) => cb(code, signal));
  });

  child.on('error', (err) => {
    eventCbs.forEach((cb) => cb({ type: 'spawn_error', message: err.message }));
    exitCbs.forEach((cb) => cb(null, null));
  });

  return {
    pid: child.pid,
    onEvent(cb) {
      eventCbs.push(cb);
    },
    onExit(cb) {
      exitCbs.push(cb);
    },
    kill() {
      child.kill();
    },
  };
}
