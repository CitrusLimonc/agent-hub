import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { app } from 'electron';

const execFileAsync = promisify(execFile);

// macOS apps launched via Finder/Dock/LaunchServices (i.e. any packaged
// build, as opposed to `npm run dev` which inherits the launching terminal's
// environment) get a minimal, bare environment — no idea that `codex`/
// `claude` live under an nvm version dir (that only ends up on PATH because
// .zshrc sources nvm.sh, which only runs for interactive shells), and no
// idea about anything else the user's .zshrc exports either. This isn't just
// a PATH problem: this user's actual Claude Code relay setup
// (ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY, pointed at a
// third-party relay, not the official API) lives entirely in `.zshrc export`
// lines — verified there's no OS keychain entry or credentials file backing
// Claude Code's login on this machine at all. Without these vars, a
// packaged-app-spawned `claude` has no way to authenticate ("Not logged in")
// and, when some other fallback auth applies, can end up talking to a
// completely different backend than the user's own terminal — explaining
// both symptoms at once. Fix: query the user's real login shell once for
// its *entire* environment (not just PATH) and merge it in before anything
// spawns.
export async function fixPath(): Promise<void> {
  if (process.platform !== 'darwin') return;

  const shellEnv = await resolveLoginShellEnv();
  const nvmBin = await findNvmBinWithBothClis();

  // Every var the shell sets wins over whatever this app's own launch
  // environment had — it represents the user's actual intended config.
  // PATH is excluded here and handled separately below.
  for (const [key, value] of Object.entries(shellEnv)) {
    if (key !== 'PATH') process.env[key] = value;
  }

  // nvmBin goes first: nvm's "default" alias can point at an old node
  // version that predates a global `codex`/`claude` install even though a
  // newer version has both (verified on this machine — default alias is
  // v16, which has codex but not claude) — so the login shell's own PATH
  // resolution can't be trusted to find both. Still merge the shell's PATH
  // in too, for every other tool this app might ever need to find.
  const parts = [nvmBin, ...(shellEnv.PATH || '').split(':'), ...(process.env.PATH || '').split(':')].filter(
    (p): p is string => !!p
  );
  process.env.PATH = Array.from(new Set(parts)).join(':');
}

/** Runs the user's real login shell once and captures its whole resolved
 * environment via `env -0` (NUL-delimited so values with newlines/colons
 * parse safely) — one shell spawn covers both PATH and everything else,
 * rather than querying PATH alone and separately re-deriving other vars.
 * The marker isolates our output from any startup banner noise `.zshrc`
 * might print (nvm version messages, motd, etc.) before `env -0` runs. */
async function resolveLoginShellEnv(): Promise<Record<string, string>> {
  const shell = process.env.SHELL || '/bin/zsh';
  const marker = '___AGENTHUB_ENV_START___\n';
  try {
    const { stdout } = await execFileAsync(shell, ['-ilc', `printf '%s' '${marker}'; env -0`], {
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const idx = stdout.indexOf(marker);
    if (idx === -1) return {};
    const result: Record<string, string> = {};
    for (const entry of stdout.slice(idx + marker.length).split('\0')) {
      const eq = entry.indexOf('=');
      if (eq === -1) continue;
      result[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return result;
  } catch {
    // Best-effort — if the login shell can't be queried in time, this just
    // contributes nothing and findNvmBinWithBothClis()/the existing PATH
    // still get a chance to resolve things.
    return {};
  }
}

/** Runs `<bin>/<name> --version` and reports whether it actually exits 0 —
 * file presence isn't enough. A global npm install under some nvm version
 * can exist on disk yet be broken at runtime (verified on this machine: the
 * `codex` install under one node version SIGKILLs on every invocation, exit
 * 137 — `spctl -a -vv` on its nested native binary reports
 * `CSSMERR_TP_CERT_REVOKED`, i.e. macOS has revoked trust in whatever
 * certificate signed that specific build. Actually *executing* a
 * revoked-cert binary is also what makes macOS pop up its "already opened,
 * contains malware" system dialog — unavoidable the first time we probe a
 * version we haven't seen before, which is why findNvmBinWithBothClis()
 * below caches the result instead of re-probing every launch).
 *
 * `codex`/`claude` are themselves `#!/usr/bin/env node` scripts — even
 * invoked by absolute path, the OS's shebang handling still shells out to
 * `env node`, which does its own PATH lookup for `node`. This runs *before*
 * fixPath() has decided on and applied a real PATH, so without explicitly
 * prepending this candidate's own bin dir (which always contains its own
 * `node`) here, `env node` fails to resolve and every candidate looks
 * broken for the wrong reason. */
async function cliWorks(bin: string, name: string): Promise<boolean> {
  try {
    await execFileAsync(path.join(bin, name), ['--version'], {
      timeout: 3000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH || ''}` },
    });
    return true;
  } catch {
    return false;
  }
}

interface VerifiedBinCache {
  bin: string;
  codexMtimeMs: number;
  claudeMtimeMs: number;
}

function cacheFilePath(): string {
  return path.join(app.getPath('userData'), 'verified-cli-bin.json');
}

async function mtimeMs(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return -1;
  }
}

/** A cache hit means this exact bin dir's codex/claude files are unchanged
 * since last verified — safe to reuse without re-running `cliWorks()`
 * (which is the only thing that would ever re-trigger macOS's
 * revoked-cert/malware dialog for some other version on disk). */
async function readVerifiedCache(): Promise<string | null> {
  try {
    const cache: VerifiedBinCache = JSON.parse(await fs.readFile(cacheFilePath(), 'utf-8'));
    const [codexMtime, claudeMtime] = await Promise.all([
      mtimeMs(path.join(cache.bin, 'codex')),
      mtimeMs(path.join(cache.bin, 'claude')),
    ]);
    if (codexMtime === cache.codexMtimeMs && claudeMtime === cache.claudeMtimeMs) {
      return cache.bin;
    }
  } catch {
    // no cache yet, or it's unreadable — fall through to a real scan
  }
  return null;
}

async function writeVerifiedCache(bin: string): Promise<void> {
  const [codexMtimeMs, claudeMtimeMs] = await Promise.all([
    mtimeMs(path.join(bin, 'codex')),
    mtimeMs(path.join(bin, 'claude')),
  ]);
  const cache: VerifiedBinCache = { bin, codexMtimeMs, claudeMtimeMs };
  await fs.writeFile(cacheFilePath(), JSON.stringify(cache), 'utf-8').catch(() => {});
}

/** Scans every nvm-installed node version (newest first) for one whose bin/
 * dir has a *working* `codex` and `claude`, rather than trusting nvm's
 * "default" alias — a version can be marked default without either CLI ever
 * having been npm-installed globally under it (verified: default alias here
 * is v16, which has codex but not claude at all). Cached after the first
 * successful scan (see readVerifiedCache) so later launches skip straight
 * to the known-good version instead of re-probing every installed version
 * — including whichever one has the revoked-cert binary — on every start. */
async function findNvmBinWithBothClis(): Promise<string | null> {
  const cached = await readVerifiedCache();
  if (cached) return cached;

  const versionsDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  let entries: string[];
  try {
    entries = await fs.readdir(versionsDir);
  } catch {
    return null;
  }

  const sorted = entries.filter((v) => /^v\d+\.\d+\.\d+$/.test(v)).sort(compareVersionsDescending);

  for (const v of sorted) {
    const bin = path.join(versionsDir, v, 'bin');
    if ((await cliWorks(bin, 'codex')) && (await cliWorks(bin, 'claude'))) {
      await writeVerifiedCache(bin);
      return bin;
    }
  }
  return null;
}

function compareVersionsDescending(a: string, b: string): number {
  const parse = (v: string) => v.slice(1).split('.').map(Number);
  const [aMaj, aMin, aPatch] = parse(a);
  const [bMaj, bMin, bPatch] = parse(b);
  return bMaj - aMaj || bMin - aMin || bPatch - aPatch;
}
