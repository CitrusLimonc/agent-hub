import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// Read/write access to Codex's and Claude Code's *global* provider config —
// deliberately separate from inspector.ts (which is read-only by design, see
// its header comment). Both setters are surgical: they only ever touch a
// dedicated "agenthub" provider/env keys, never rewrite or reformat the rest
// of the user's existing config (their other providers, ~30 [projects."..."]
// trust entries in Codex's config.toml, etc). This is what makes it safe to
// write straight to the same files `codex`/`claude` read when run directly
// in a terminal, rather than maintaining an AgentHub-only override.

const CODEX_HOME = path.join(os.homedir(), '.codex');
const CLAUDE_HOME = path.join(os.homedir(), '.claude');

export interface ProviderConfig {
  baseUrl: string | null;
  hasApiKey: boolean;
}

export interface SetProviderConfigOptions {
  baseUrl?: string;
  apiKey?: string;
}

/** Per-directory trust status for both CLIs. An untrusted directory means
 * Codex/Claude Code ignore the directory's own permission whitelist
 * (Codex `[projects."..."]` config, Claude `.claude/settings.local.json`
 * `permissions.allow`) — headless runs can't show the interactive trust
 * dialog, so the user sees "Ignoring N permissions.allow entries …" instead.
 * See getDirTrust/setDirTrusted below. */
export interface DirTrustStatus {
  codex: boolean;
  claude: boolean;
}

/** Pipes `input` to `cmd`'s stdin rather than passing it as an argv entry —
 * `codex login --with-api-key` reads the key this way specifically so it
 * never shows up in `ps`/process-argv snooping. */
function runWithStdin(cmd: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}: ${stderr.trim()}`));
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

/** Locates a top-level TOML table by its exact `[header]` text and returns
 * the byte range from the header through just before the next top-level
 * `[...]` header (or EOF) — i.e. "this whole block, nothing more". Used both
 * to read the block's contents and, in the setter, to replace it in place
 * without touching anything before or after it. */
function findTopLevelBlockRange(text: string, header: string): { start: number; end: number } | null {
  const start = text.indexOf(header);
  if (start === -1) return null;
  const afterHeader = start + header.length;
  const nextHeaderMatch = text.slice(afterHeader).match(/\n\[/);
  const end = nextHeaderMatch ? afterHeader + nextHeaderMatch.index! + 1 : text.length;
  return { start, end };
}

// ---------- Codex ----------

export async function getCodexProviderConfig(): Promise<ProviderConfig> {
  const configPath = path.join(CODEX_HOME, 'config.toml');
  const authPath = path.join(CODEX_HOME, 'auth.json');

  let baseUrl: string | null = null;
  try {
    const text = await fs.readFile(configPath, 'utf-8');
    const providerName = text.match(/^model_provider\s*=\s*"([^"]*)"\s*$/m)?.[1];
    if (providerName) {
      const range = findTopLevelBlockRange(text, `[model_providers.${providerName}]`);
      if (range) {
        const block = text.slice(range.start, range.end);
        baseUrl = block.match(/base_url\s*=\s*"([^"]*)"/)?.[1] ?? null;
      }
    }
  } catch {
    // no config.toml yet — nothing active
  }

  let hasApiKey = false;
  try {
    const auth = JSON.parse(await fs.readFile(authPath, 'utf-8'));
    hasApiKey = typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.length > 0;
  } catch {
    // no auth.json yet — not logged in
  }

  return { baseUrl, hasApiKey };
}

/** Only ever adds/updates a dedicated `[model_providers.agenthub]` table and
 * the top-level `model_provider` line that activates it — every other
 * provider block and every `[projects."..."]` trust entry in config.toml is
 * left byte-for-byte untouched. The API key never goes through this file at
 * all; it's handled separately via `codex login --with-api-key` below. */
export async function setCodexProviderConfig(opts: SetProviderConfigOptions): Promise<void> {
  if (opts.apiKey) {
    await runWithStdin('codex', ['login', '--with-api-key'], opts.apiKey);
  }

  if (opts.baseUrl) {
    const configPath = path.join(CODEX_HOME, 'config.toml');
    let text = '';
    try {
      text = await fs.readFile(configPath, 'utf-8');
    } catch {
      text = '';
    }

    const providerLineRe = /^model_provider\s*=\s*"[^"]*"\s*$/m;
    const providerLine = 'model_provider = "agenthub"';
    text = providerLineRe.test(text) ? text.replace(providerLineRe, providerLine) : `${providerLine}\n${text}`;

    const header = '[model_providers.agenthub]';
    const safeUrl = opts.baseUrl.replace(/"/g, '\\"');
    const blockText = `${header}\nname = "agenthub"\nbase_url = "${safeUrl}"\nwire_api = "responses"\n`;
    const range = findTopLevelBlockRange(text, header);
    text = range
      ? text.slice(0, range.start) + blockText + text.slice(range.end)
      : `${text}${text.endsWith('\n') ? '\n' : '\n\n'}${blockText}`;

    await fs.writeFile(configPath, text, 'utf-8');
  }
}

// ---------- Claude Code ----------

export async function getClaudeProviderConfig(): Promise<ProviderConfig> {
  const settingsPath = path.join(CLAUDE_HOME, 'settings.json');
  let data: any = {};
  try {
    data = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
  } catch {
    data = {};
  }
  const env = data.env ?? {};
  const baseUrl = typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL ? env.ANTHROPIC_BASE_URL : null;
  const hasApiKey =
    (typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN.length > 0) ||
    (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.length > 0);
  return { baseUrl, hasApiKey };
}

/** Merges into `settings.json`'s existing `env` object rather than
 * replacing it, so unrelated env vars and top-level fields (theme, model,
 * ...) survive untouched. Relay setups (baseUrl set) conventionally use
 * `ANTHROPIC_AUTH_TOKEN`; the official endpoint uses `ANTHROPIC_API_KEY` —
 * only one is kept at a time so there's no ambiguity about which wins. */
export async function setClaudeProviderConfig(opts: SetProviderConfigOptions): Promise<void> {
  const settingsPath = path.join(CLAUDE_HOME, 'settings.json');
  let data: any = {};
  try {
    data = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
  } catch {
    data = {};
  }
  const env = { ...(data.env ?? {}) };

  if (opts.baseUrl !== undefined) {
    if (opts.baseUrl) env.ANTHROPIC_BASE_URL = opts.baseUrl;
    else delete env.ANTHROPIC_BASE_URL;
  }

  if (opts.apiKey) {
    const usingRelay = Boolean(opts.baseUrl ?? env.ANTHROPIC_BASE_URL);
    if (usingRelay) {
      env.ANTHROPIC_AUTH_TOKEN = opts.apiKey;
      delete env.ANTHROPIC_API_KEY;
    } else {
      env.ANTHROPIC_API_KEY = opts.apiKey;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
  }

  data.env = env;
  await fs.writeFile(settingsPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

// ---------- Per-directory trust (Codex [projects."..."] + Claude ~/.claude.json) ----------

/** Reads whether each CLI trusts `cwd`. Codex: a `[projects."<cwd>"]` table
 * in config.toml with `trust_level = "trusted"`. Claude:
 * `projects[cwd].hasTrustDialogAccepted` in ~/.claude.json. */
export async function getDirTrust(cwd: string): Promise<DirTrustStatus> {
  // ---- Codex ----
  let codex = false;
  try {
    const text = await fs.readFile(path.join(CODEX_HOME, 'config.toml'), 'utf-8');
    const header = `[projects.${JSON.stringify(cwd)}]`;
    const range = findTopLevelBlockRange(text, header);
    if (range) {
      codex = /trust_level\s*=\s*"trusted"/.test(text.slice(range.start, range.end));
    }
  } catch {
    // no config.toml — nothing is trusted
  }

  // ---- Claude ----
  let claude = false;
  try {
    const data = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude.json'), 'utf-8'));
    claude = data.projects?.[cwd]?.hasTrustDialogAccepted === true;
  } catch {
    // no .claude.json — nothing is trusted
  }

  return { codex, claude };
}

/** Marks `cwd` as trusted for BOTH CLIs — an explicit user action in the UI
 * (NewTaskForm's "信任此目录" button), never done silently: trusting a
 * directory activates its local permission whitelists, which is exactly the
 * trust decision Claude Code's interactive dialog exists to ask about.
 *
 * Codex: same surgical find-or-insert patch as setCodexProviderConfig — a
 * `[projects."<cwd>"]` table with `trust_level = "trusted"`, appended if
 * absent, replaced in place if the table exists (e.g. currently
 * "untrusted"). Claude: JSON-merge into ~/.claude.json's projects[cwd],
 * preserving that entry's other fields (allowedTools, mcpServers, usage
 * stats, …) — or creating a minimal entry if the project isn't known yet. */
export async function setDirTrusted(cwd: string): Promise<DirTrustStatus> {
  // ---- Codex ----
  const configPath = path.join(CODEX_HOME, 'config.toml');
  let text = '';
  try {
    text = await fs.readFile(configPath, 'utf-8');
  } catch {
    text = '';
  }
  const header = `[projects.${JSON.stringify(cwd)}]`;
  const blockText = `${header}\ntrust_level = "trusted"\n`;
  const range = findTopLevelBlockRange(text, header);
  text = range
    ? text.slice(0, range.start) + blockText + text.slice(range.end)
    : `${text}${text.endsWith('\n') ? '\n' : '\n\n'}${blockText}`;
  await fs.writeFile(configPath, text, 'utf-8');

  // ---- Claude ----
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  let data: any = {};
  try {
    data = JSON.parse(await fs.readFile(claudeJsonPath, 'utf-8'));
  } catch {
    data = {};
  }
  if (typeof data.projects !== 'object' || data.projects === null) data.projects = {};
  data.projects[cwd] = { ...(data.projects[cwd] ?? {}), hasTrustDialogAccepted: true };
  await fs.writeFile(claudeJsonPath, JSON.stringify(data, null, 2), 'utf-8');

  return getDirTrust(cwd);
}
