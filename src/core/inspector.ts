import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import type { ChatMessage, SkillInfo, SessionSummary } from './types';

// Read-only inspection of Codex/Claude's own state on disk and via their
// CLIs — status, config, skills, and (unlike taskRunner.ts, which only ever
// reads its own live event stream) the session history either CLI has ever
// written, including sessions AgentHub never touched. This file never writes
// anything and doesn't know about taskStore — main.ts's listConversations()
// is what cross-references this module's disk scan with AgentHub's own
// tracked tasks.

const execFileAsync = promisify(execFile);

const CODEX_HOME = path.join(os.homedir(), '.codex');
const CLAUDE_HOME = path.join(os.homedir(), '.claude');

async function readFileSafe(p: string): Promise<string> {
  try {
    return await fs.readFile(p, 'utf-8');
  } catch (err: any) {
    return `(读取失败: ${err.message})`;
  }
}

/** Tolerant YAML frontmatter reader — just enough for `name:`/`description:`,
 * including block-scalar (`description: |`) descriptions used by our skills. */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  let blockKey: string | null = null;
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      const [, key, rest] = kv;
      if (rest === '|' || rest === '>') {
        blockKey = key;
        result[key] = '';
      } else {
        blockKey = null;
        result[key] = rest.trim().replace(/^["'](.*)["']$/, '$1');
      }
    } else if (blockKey && /^\s+\S/.test(line)) {
      result[blockKey] += (result[blockKey] ? ' ' : '') + line.trim();
    }
  }
  return result;
}

/** Skills live as `<skillsDir>/<name>/SKILL.md`, possibly one level deeper
 * inside a container dir (Codex nests built-ins under `.system/`). */
async function listSkillsIn(skillsDir: string, maxDepth = 2): Promise<SkillInfo[]> {
  const results: SkillInfo[] = [];

  async function walk(dir: string, level: number) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Skill dirs are sometimes symlinks (e.g. installed from a shared
      // store) — Dirent.isDirectory() is false for those, so don't filter by
      // type here; just try reading SKILL.md and let failures fall through.
      const full = path.join(dir, entry.name);
      try {
        const content = await fs.readFile(path.join(full, 'SKILL.md'), 'utf-8');
        const fm = parseFrontmatter(content);
        results.push({ name: fm.name || entry.name, description: fm.description || '', path: full });
      } catch {
        if (level < maxDepth) await walk(full, level + 1);
      }
    }
  }

  await walk(skillsDir, 1);
  return results;
}

async function readFirstBytes(filePath: string, maxBytes: number): Promise<string> {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString('utf-8');
  } finally {
    await fh.close();
  }
}

/** Session files can run to several MB, so history summaries only ever read
 * a bounded head chunk — enough to cover the first few dozen lines, which is
 * where session_meta / ai-title / the real first prompt all live. The final
 * line of that chunk is dropped since the byte cutoff can land mid-line. */
const HISTORY_HEAD_BYTES = 262144;

async function readCompleteLines(filePath: string, maxBytes: number): Promise<string[]> {
  const head = await readFirstBytes(filePath, maxBytes);
  const lines = head.split('\n');
  lines.pop();
  return lines;
}

// ---------- Codex ----------

export async function getCodexStatus(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('codex', ['doctor', '--json']);
    return JSON.stringify(JSON.parse(stdout), null, 2);
  } catch (err: any) {
    // `codex doctor` exits non-zero when overallStatus is "warning"/"error" —
    // that's still a valid report, not a real failure, so show it if present.
    if (typeof err.stdout === 'string' && err.stdout.trim()) {
      try {
        return JSON.stringify(JSON.parse(err.stdout), null, 2);
      } catch {
        // fall through to the generic error message below
      }
    }
    return `codex doctor 执行失败: ${err.message}`;
  }
}

export async function getCodexSettings(): Promise<string> {
  const p = path.join(CODEX_HOME, 'config.toml');
  return `# ${p}\n\n${await readFileSafe(p)}`;
}

export async function getCodexSkills(): Promise<SkillInfo[]> {
  return listSkillsIn(path.join(CODEX_HOME, 'skills'));
}

/** Codex stores the AI-generated thread name in its state database. Rollout
 * files only contain the first user message, which the sidebar previously had
 * to fall back to. Read the persisted names (when present) before parsing the
 * rollout files so history entries match `/status`. */
async function readCodexThreadNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const dbPath = path.join(CODEX_HOME, 'state_5.sqlite');
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        `SELECT id, name
         FROM threads
         WHERE name IS NOT NULL AND trim(name) <> ''`
      )
      .all() as Array<{ id: string; name: string }>;
    for (const row of rows) names.set(row.id, row.name.trim());
  } catch {
    // Older Codex installs may not have this database/schema yet; the first
    // user message remains a usable fallback in that case.
  } finally {
    db?.close();
  }
  return names;
}

export async function getCodexHistory(limit = 200, pinnedSessions = new Map<string, string | null>()): Promise<SessionSummary[]> {
  const sessionsDir = path.join(CODEX_HOME, 'sessions');
  let entries: string[];
  try {
    entries = (await fs.readdir(sessionsDir, { recursive: true })) as string[];
  } catch {
    return [];
  }

  const jsonlPaths = entries.filter((e) => e.endsWith('.jsonl')).map((e) => path.join(sessionsDir, e));
  const withStat = await Promise.all(
    jsonlPaths.map(async (p) => {
      try {
        return { path: p, mtime: (await fs.stat(p)).mtimeMs };
      } catch {
        return null;
      }
    })
  );
  const sorted = withStat.filter((x): x is { path: string; mtime: number } => !!x).sort((a, b) => b.mtime - a.mtime);

  // One-time dispatched sessions (e.g. this user's orchestrator system
  // launching `codex` with a CLI-override provider like
  // `orchestrator_override`) record that provider name in session_meta, but
  // the definition only existed in that one command's `-c` overrides and is
  // NOT in config.toml. Resuming such a session fails hard ("Model provider
  // `orchestrator_override` not found", exit 1 — verified identical outside
  // AgentHub), so they're dead weight in the sidebar. Filter: a recorded
  // provider that is neither in config.toml nor a Codex built-in means the
  // session can never resume. Absent provider field (older sessions) passes.
  const configuredProviders = await readConfiguredModelProviders();
  const threadNames = await readCodexThreadNames();

  const results: SessionSummary[] = [];
  const pinnedPaths = new Set(pinnedSessions.values());
  for (const f of sorted.filter((file, index) => index < limit || pinnedPaths.has(file.path))) {
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let timestamp: string | undefined;
    let title: string | undefined;
    let fullTitle: string | undefined;
    let modelProvider: string | undefined;

    const lines = await readCompleteLines(f.path, HISTORY_HEAD_BYTES).catch(() => [] as string[]);
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.type === 'session_meta') {
        sessionId = parsed.payload?.session_id;
        cwd = parsed.payload?.cwd;
        timestamp = parsed.timestamp;
        modelProvider = parsed.payload?.model_provider;
      } else if (!title && parsed.type === 'response_item' && parsed.payload?.role === 'user') {
        // Codex has no auto-title; the first real (non-environment-context)
        // user message is the closest thing to one.
        const text = parsed.payload?.content?.[0]?.text;
        if (typeof text === 'string' && !text.startsWith('<environment_context>')) {
          title = text.length > 80 ? `${text.slice(0, 80)}…` : text;
          fullTitle = text;
        }
      }
    }

    if (modelProvider && !configuredProviders.has(modelProvider)) continue;

    results.push({
      id: sessionId ?? path.basename(f.path, '.jsonl'),
      cwd: cwd ?? '(unknown)',
      timestamp: timestamp ?? new Date(f.mtime).toISOString(),
      title: (sessionId && threadNames.get(sessionId)) || title || null,
      fullTitle: (sessionId && threadNames.get(sessionId)) || fullTitle,
      path: f.path,
      lastModifiedAt: new Date(f.mtime).toISOString(),
    });
  }
  // A deliberately pinned session must not disappear into a similar burst.
  const pinned = results.filter((r) => pinnedSessions.has(r.id));
  const unpinned = results.filter((r) => !pinnedSessions.has(r.id));
  return [...dedupeById(pinned), ...collapseBursts(unpinned)];
}

/** Names of every `[model_providers.<name>]` in config.toml plus Codex's
 * built-in provider names — sessions recorded with anything else were
 * launched with CLI `-c` overrides and can never be resumed. Verified on
 * this machine: sessions recorded with `OpenAI` (capitalized, from old
 * CLI overrides) ALSO fail resume with "Model provider `OpenAI` not
 * found" — capitalization does NOT make it a valid built-in, so only
 * lowercase built-ins are whitelisted. */
async function readConfiguredModelProviders(): Promise<Set<string>> {
  const names = new Set<string>(['openai', 'oss']);
  try {
    const text = await fs.readFile(path.join(CODEX_HOME, 'config.toml'), 'utf-8');
    for (const m of text.matchAll(/^\[model_providers\.([^\]]+)\]/gm)) {
      names.add(m[1].replace(/^"|"$/g, ''));
    }
  } catch {
    // no config.toml — only built-ins count as resumable
  }
  return names;
}

/** Codex has no concept of "sub-agent" sessions the way Claude's Task tool
 * does (no field anywhere marks a session as automation-spawned) — but this
 * user's actual `~/.codex/sessions` has bursts of many sessions sharing an
 * identical (cwd, title), minutes apart, from scheduled/health-check jobs
 * that happen to also invoke the `codex` CLI on this machine. Those flood
 * the sidebar with what looks like duplicate "child" entries. Collapses each
 * run of same-(cwd,title) sessions whose timestamps are within
 * BURST_WINDOW_MS of the nearest more-recent kept entry into that one entry,
 * tagged with how many were folded in — occasional genuine repeats of the
 * same prompt hours/days apart (e.g. testing with "hi" twice a month apart)
 * fall outside the window and are kept as separate entries. `results` must
 * already be sorted newest-first. */
const BURST_WINDOW_MS = 10 * 60 * 1000;

function collapseBursts(results: SessionSummary[]): SessionSummary[] {
  const deduped = dedupeById(results);
  const byKey = new Map<string, SessionSummary[]>();
  for (const r of deduped) {
    const key = `${r.cwd} ${r.title ?? ''}`;
    const group = byKey.get(key);
    if (group) group.push(r);
    else byKey.set(key, [r]);
  }

  // Keyed by object identity, not `.id` — dedupeById() already guarantees
  // unique ids here, but identity keying is the safer invariant regardless.
  const mergedCounts = new Map<SessionSummary, number>();
  const dropped = new Set<SessionSummary>();
  for (const group of byKey.values()) {
    let anchor = group[0];
    let anchorTime = new Date(anchor.timestamp).getTime();
    let count = 1;

    for (let i = 1; i < group.length; i++) {
      const t = new Date(group[i].timestamp).getTime();
      if (anchorTime - t > BURST_WINDOW_MS) {
        mergedCounts.set(anchor, count);
        anchor = group[i];
        anchorTime = t;
        count = 1;
      } else {
        dropped.add(group[i]);
        count++;
      }
    }
    mergedCounts.set(anchor, count);
  }

  return deduped
    .filter((r) => !dropped.has(r))
    .map((r) => {
      const count = mergedCounts.get(r) ?? 1;
      return count > 1 ? { ...r, mergedCount: count } : r;
    });
}

/** `codex resume` writes a new rollout file per turn but keeps the same
 * `id` (session_id) in every file's session_meta, and the title (derived
 * from the first user message) never changes across turns — so a single
 * real multi-turn conversation looks exactly like a same-(cwd,title) burst
 * to collapseBursts() above. Collapse same-id rows to one first (keeping
 * the earliest, matching the "createdAt = first message" semantic main.ts
 * relies on) so the burst window only ever compares genuinely distinct
 * conversations. `lastModifiedAt` takes the *newest* file's mtime — the
 * latest resume's rollout is the one whose mtime says when this
 * conversation was last touched, which is what sidebar recency sorting
 * needs (keeping the earliest's mtime would bury a resumed conversation
 * back at its creation date). */
function dedupeById(results: SessionSummary[]): SessionSummary[] {
  const byId = new Map<string, SessionSummary>();
  for (const r of results) {
    const existing = byId.get(r.id);
    if (!existing) {
      byId.set(r.id, r);
      continue;
    }
    if (new Date(r.timestamp).getTime() < new Date(existing.timestamp).getTime()) {
      byId.set(r.id, {
        ...r,
        lastModifiedAt: latestIso(r.lastModifiedAt, existing.lastModifiedAt),
      });
    } else {
      existing.lastModifiedAt = latestIso(r.lastModifiedAt, existing.lastModifiedAt);
    }
  }
  return Array.from(byId.values()).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function latestIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

// ---------- Claude Code ----------

export async function getClaudeStatus(): Promise<string> {
  const parts: string[] = [];
  try {
    const { stdout } = await execFileAsync('claude', ['--version']);
    parts.push(`version: ${stdout.trim()}`);
  } catch (err: any) {
    parts.push(`--version 失败: ${err.message}`);
  }
  try {
    const { stdout } = await execFileAsync('claude', ['auth', 'status']);
    parts.push(`\nauth status:\n${stdout.trim()}`);
  } catch (err: any) {
    parts.push(`\nauth status 失败: ${err.message}`);
  }
  return parts.join('\n');
}

export async function getClaudeSettings(): Promise<string> {
  const settings = await readFileSafe(path.join(CLAUDE_HOME, 'settings.json'));
  const local = await readFileSafe(path.join(CLAUDE_HOME, 'settings.local.json'));
  return `# ~/.claude/settings.json\n\n${settings}\n\n# ~/.claude/settings.local.json\n\n${local}`;
}

export async function getClaudeSkills(): Promise<SkillInfo[]> {
  return listSkillsIn(path.join(CLAUDE_HOME, 'skills'), 1);
}

export async function getClaudeHistory(limit = 200, pinnedSessions = new Map<string, string | null>()): Promise<SessionSummary[]> {
  const projectsDir = path.join(CLAUDE_HOME, 'projects');
  let projectDirs: string[];
  try {
    // Project dirs can be symlinks — don't filter by Dirent.isDirectory().
    projectDirs = (await fs.readdir(projectsDir, { withFileTypes: true })).map((e) => e.name);
  } catch {
    return [];
  }

  const allFiles: { path: string; mtime: number }[] = [];
  for (const proj of projectDirs) {
    const dir = path.join(projectsDir, proj);
    let files;
    try {
      files = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.name.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dir, f.name);
      try {
        allFiles.push({ path: full, mtime: (await fs.stat(full)).mtimeMs });
      } catch {
        continue;
      }
    }
  }
  allFiles.sort((a, b) => b.mtime - a.mtime);

  const results: SessionSummary[] = [];
  const pinnedPaths = new Set(pinnedSessions.values());
  for (const f of allFiles.filter((file, index) => index < limit || pinnedPaths.has(file.path) || pinnedSessions.has(path.basename(file.path, '.jsonl')))) {
    let cwd: string | undefined;
    let timestamp: string | undefined;
    let title: string | undefined;
    let firstUserTitle: string | undefined;
    let firstUserFullTitle: string | undefined;
    let isBackgroundDispatch = false;

    const lines = await readCompleteLines(f.path, HISTORY_HEAD_BYTES).catch(() => [] as string[]);
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!cwd && typeof parsed.cwd === 'string') cwd = parsed.cwd;
      if (!timestamp && typeof parsed.timestamp === 'string') timestamp = parsed.timestamp;
      if (parsed.type === 'ai-title' && typeof parsed.aiTitle === 'string') title = parsed.aiTitle;
      // First-user-message fallback title — same convention getCodexHistory
      // uses. Without it, a terminal-mode Claude session shows the raw cwd
      // in the sidebar until Claude's async ai-title lands (which can take
      // several turns or never come for short chats). isMeta entries and
      // '<'-prefixed injected contexts (<command-name>, <local-command>…)
      // aren't real user prompts and must not become titles.
      if (!firstUserTitle && parsed.type === 'user' && !parsed.isMeta && parsed.sessionKind !== 'bg') {
        const content = parsed.message?.content;
        let text: string | undefined;
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('\n');
        }
        if (text && !text.startsWith('<')) {
          firstUserTitle = text.length > 80 ? `${text.slice(0, 80)}…` : text;
          firstUserFullTitle = text;
        }
      }
      // Sessions Claude Code dispatches to itself (e.g. via the Task tool's
      // background-agent routing) carry `sessionKind: "bg"` on their first
      // user message — same title as the parent conversation that spawned
      // them, which is what makes them look like confusing duplicates in a
      // human-facing history list. Regular interactive sessions never set
      // this field.
      if (parsed.type === 'user' && parsed.sessionKind === 'bg') isBackgroundDispatch = true;
    }

    if (isBackgroundDispatch) continue;

    results.push({
      id: path.basename(f.path, '.jsonl'),
      cwd: cwd ?? '(unknown)',
      timestamp: timestamp ?? new Date(f.mtime).toISOString(),
      // ai-title (Claude's own generated title) wins once it exists; before
      // that, the first-user-message fallback keeps the sidebar from showing
      // a bare directory path for fresh terminal-mode sessions.
      title: title ?? firstUserTitle ?? null,
      fullTitle: title ?? firstUserFullTitle,
      path: f.path,
      lastModifiedAt: new Date(f.mtime).toISOString(),
    });
  }
  return results;
}

// ---------- Full transcripts (reconstructing a past conversation) ----------

/** `custom_tool_call.input` is often a JS-wrapper string like
 * `const r = await tools.exec_command({cmd:"...",...})` rather than a plain
 * command — pull the `cmd` out if we can find it, otherwise show the raw
 * (truncated) input. This is best-effort; Codex's on-disk tool-call shape
 * isn't as clean as the `item.completed` events `codex exec --json` emits. */
function summarizeCodexToolInput(input: unknown): string {
  if (typeof input !== 'string') {
    return JSON.stringify(input ?? '').slice(0, 200);
  }
  const cmdMatch = input.match(/cmd\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (cmdMatch) {
    try {
      return JSON.parse(`"${cmdMatch[1]}"`);
    } catch {
      return cmdMatch[1];
    }
  }
  return input.length > 200 ? `${input.slice(0, 200)}…` : input;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Reads the *entire* rollout file (unlike the head-chunk reads used for
 * history summaries) and reconstructs the visible conversation. Session
 * files have been seen up to ~10MB, so this can be slow for the largest
 * sessions — no pagination yet, see README limitations. */
export async function getCodexTranscript(filePath: string): Promise<ChatMessage[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const messages: ChatMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== 'response_item' || !d.payload) continue;
    const p = d.payload;

    if (p.type === 'message') {
      if (p.role === 'developer') continue; // system/skills instructions, not user-visible
      const text = (p.content ?? [])
        .map((c: any) => c.text)
        .filter((t: any) => typeof t === 'string')
        .join('\n');
      if (!text) continue;
      if (p.role === 'user') {
        if (text.startsWith('<environment_context>')) continue;
        messages.push({ role: 'user', text, timestamp: d.timestamp });
      } else if (p.role === 'assistant') {
        messages.push({ role: 'assistant', text, timestamp: d.timestamp });
      }
    } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      const summary = summarizeCodexToolInput(p.input ?? p.arguments);
      messages.push({ role: 'tool', text: `🔧 ${p.name ?? 'tool'}: ${summary}`, timestamp: d.timestamp });
    } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      const out = p.output;
      let text: string;
      if (Array.isArray(out)) {
        text = out
          .map((o: any) => o.text)
          .filter((t: any) => typeof t === 'string')
          .join('\n');
      } else if (typeof out === 'string') {
        text = out;
      } else {
        text = JSON.stringify(out ?? '');
      }
      messages.push({ role: 'tool', text: `→ ${truncate(text, 400)}`, timestamp: d.timestamp });
    }
  }
  return messages;
}

function extractClaudeToolResultText(content: unknown): string {
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
  return truncate(text, 400);
}

export async function getClaudeTranscript(filePath: string): Promise<ChatMessage[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const messages: ChatMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = d.message;
    if (!msg) continue;

    if (d.type === 'user') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', text: msg.content, timestamp: d.timestamp });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            messages.push({ role: 'tool', text: `→ ${extractClaudeToolResultText(block.content)}`, timestamp: d.timestamp });
          } else if (block.type === 'text' && typeof block.text === 'string') {
            messages.push({ role: 'user', text: block.text, timestamp: d.timestamp });
          }
        }
      }
    } else if (d.type === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          messages.push({ role: 'assistant', text: block.text, timestamp: d.timestamp });
        } else if (block.type === 'tool_use') {
          const inputStr = truncate(JSON.stringify(block.input ?? {}), 200);
          messages.push({ role: 'tool', text: `🔧 ${block.name}: ${inputStr}`, timestamp: d.timestamp });
        }
      }
    }
  }
  return messages;
}

// ---------- Deleting sessions (bulk-delete from the history sidebar) ----------

/** Goes through `codex delete` rather than `fs.unlink` so Codex's own sqlite
 * index (thread_history_1.sqlite — see README) doesn't end up with a stale
 * entry pointing at a rollout file that no longer exists. `--force` is
 * required — without it `codex delete` refuses non-interactively ("cannot
 * confirm session deletion without an interactive terminal"), verified
 * against a real session. */
export async function deleteCodexSession(sessionId: string): Promise<void> {
  await execFileAsync('codex', ['delete', sessionId, '--force']);
}

/** Claude Code has no CLI equivalent of `codex delete`, so this just removes
 * the session's jsonl file directly. */
export async function deleteClaudeSession(filePath: string): Promise<void> {
  await fs.unlink(filePath);
}
