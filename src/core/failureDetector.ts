/**
 * Neither CLI documents exit-code semantics, and Codex silently retries
 * transient errors (rate limits etc.) without ever emitting a terminal event
 * for them. A task that goes quiet mid-run — no new event for `timeoutMs` —
 * is treated as stalled/hung and surfaced as a failure the same way an
 * explicit error event would be.
 */
export interface StallWatcher {
  touch(): void;
  stop(): void;
}

export function createStallWatcher(timeoutMs: number, onStall: () => void): StallWatcher {
  let timer: NodeJS.Timeout | null = setTimeout(onStall, timeoutMs);

  return {
    touch() {
      if (!timer) return;
      clearTimeout(timer);
      timer = setTimeout(onStall, timeoutMs);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export const DEFAULT_STALL_TIMEOUT_MS = 90_000;
