import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { AgentKind, NewTaskInput, TaskEventRecord, TaskRecord, TaskStatus } from './types';

// Sqlite persistence for tasks. One row = one spawned process (one `codex
// exec` / `claude -p` run) — see taskRunner.ts. A multi-turn conversation is
// several rows that share the same `session_id`, linked only implicitly by
// that column (main.ts's listConversations() groups them back together).
// `task_events` stores every raw JSONL line each task emitted, keyed by
// task_id, so a conversation's live output survives an app restart.

interface TaskRow {
  id: string;
  agent: AgentKind;
  cwd: string;
  prompt: string;
  session_id: string | null;
  status: TaskStatus;
  created_at: number;
  updated_at: number;
  handoff_from_task_id: string | null;
  handoff_to_task_id: string | null;
  exit_code: number | null;
  last_message: string | null;
}

function rowToTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    agent: row.agent,
    cwd: row.cwd,
    prompt: row.prompt,
    sessionId: row.session_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    handoffFromTaskId: row.handoff_from_task_id,
    handoffToTaskId: row.handoff_to_task_id,
    exitCode: row.exit_code,
    lastMessage: row.last_message,
  };
}

export class TaskStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        cwd TEXT NOT NULL,
        prompt TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        handoff_from_task_id TEXT,
        handoff_to_task_id TEXT,
        exit_code INTEGER,
        last_message TEXT
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        raw TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id);
      CREATE TABLE IF NOT EXISTS conversation_titles (
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        PRIMARY KEY (agent, session_id)
      );
      CREATE TABLE IF NOT EXISTS conversation_pins (
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        pinned_at INTEGER NOT NULL,
        session_path TEXT,
        PRIMARY KEY (agent, session_id)
      );
    `);
  }

  createTask(input: NewTaskInput): TaskRecord {
    const now = Date.now();
    const task: TaskRecord = {
      id: randomUUID(),
      agent: input.agent,
      cwd: input.cwd,
      prompt: input.prompt,
      sessionId: null,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      handoffFromTaskId: null,
      handoffToTaskId: null,
      exitCode: null,
      lastMessage: null,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, agent, cwd, prompt, session_id, status, created_at, updated_at, handoff_from_task_id, handoff_to_task_id, exit_code, last_message)
         VALUES (@id, @agent, @cwd, @prompt, @sessionId, @status, @createdAt, @updatedAt, @handoffFromTaskId, @handoffToTaskId, @exitCode, @lastMessage)`
      )
      .run(task);
    return task;
  }

  appendEvent(taskId: string, raw: unknown) {
    this.db
      .prepare(`INSERT INTO task_events (task_id, ts, raw) VALUES (?, ?, ?)`)
      .run(taskId, Date.now(), JSON.stringify(raw));
    this.db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(Date.now(), taskId);
  }

  setSessionId(taskId: string, sessionId: string) {
    this.db.prepare(`UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?`).run(sessionId, Date.now(), taskId);
  }

  setLastMessage(taskId: string, message: string) {
    this.db
      .prepare(`UPDATE tasks SET last_message = ?, updated_at = ? WHERE id = ?`)
      .run(message, Date.now(), taskId);
  }

  // COALESCE keeps the previous exit_code when this call doesn't have one
  // (e.g. a stall-timeout kill has no real process exit code to report).
  updateStatus(taskId: string, status: TaskStatus, exitCode?: number | null) {
    this.db
      .prepare(`UPDATE tasks SET status = ?, exit_code = COALESCE(?, exit_code), updated_at = ? WHERE id = ?`)
      .run(status, exitCode ?? null, Date.now(), taskId);
  }

  // Sets the link in both directions so either task record alone is enough
  // to find its counterpart (UI shows "switched from X" / "switched to Y").
  linkHandoff(fromTaskId: string, toTaskId: string) {
    this.db.prepare(`UPDATE tasks SET handoff_to_task_id = ? WHERE id = ?`).run(toTaskId, fromTaskId);
    this.db.prepare(`UPDATE tasks SET handoff_from_task_id = ? WHERE id = ?`).run(fromTaskId, toTaskId);
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasks(): TaskRecord[] {
    const rows = this.db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC`).all() as TaskRow[];
    return rows.map(rowToTask);
  }

  /** User titles are local overrides, independent of CLI-generated titles
   * which can change on later turns. An empty title restores the default. */
  setConversationTitle(agent: AgentKind, sessionId: string, title: string | null): string | null {
    if ((agent !== 'codex' && agent !== 'claude') || typeof sessionId !== 'string' || !sessionId.trim() ||
        sessionId.length > 200 || (title !== null && (typeof title !== 'string' || title.length > 500))) {
      throw new Error('无效的会话标题（最多 500 字符）。');
    }
    const value = title?.trim() || null;
    if (value) {
      this.db.prepare(`INSERT INTO conversation_titles (agent, session_id, title) VALUES (?, ?, ?)
        ON CONFLICT(agent, session_id) DO UPDATE SET title = excluded.title`).run(agent, sessionId, value);
    } else {
      this.db.prepare(`DELETE FROM conversation_titles WHERE agent = ? AND session_id = ?`).run(agent, sessionId);
    }
    return value;
  }

  getConversationTitles(): Map<string, string> {
    const rows = this.db.prepare(`SELECT agent, session_id, title FROM conversation_titles`).all() as
      { agent: AgentKind; session_id: string; title: string }[];
    return new Map(rows.map((r) => [`${r.agent}:${r.session_id}`, r.title]));
  }

  setConversationPinned(agent: AgentKind, sessionId: string, pinned: boolean, sessionPath: string | null): void {
    if ((agent !== 'codex' && agent !== 'claude') || typeof sessionId !== 'string' || !sessionId.trim() ||
        sessionId.length > 200 || typeof pinned !== 'boolean' || (sessionPath !== null && typeof sessionPath !== 'string')) {
      throw new Error('无效的会话置顶参数。');
    }
    if (pinned) {
      this.db.prepare(`INSERT INTO conversation_pins (agent, session_id, pinned_at, session_path) VALUES (?, ?, ?, ?)
        ON CONFLICT(agent, session_id) DO UPDATE SET session_path = COALESCE(excluded.session_path, conversation_pins.session_path)`)
        .run(agent, sessionId, Date.now(), sessionPath);
    } else {
      this.db.prepare(`DELETE FROM conversation_pins WHERE agent = ? AND session_id = ?`).run(agent, sessionId);
    }
  }

  getConversationPins(): Map<string, { pinnedAt: number; path: string | null }> {
    const rows = this.db.prepare(`SELECT agent, session_id, pinned_at, session_path FROM conversation_pins`).all() as
      { agent: AgentKind; session_id: string; pinned_at: number; session_path: string | null }[];
    return new Map(rows.map((r) => [`${r.agent}:${r.session_id}`, { pinnedAt: r.pinned_at, path: r.session_path }]));
  }

  getEvents(taskId: string): TaskEventRecord[] {
    const rows = this.db
      .prepare(`SELECT id, task_id, ts, raw FROM task_events WHERE task_id = ? ORDER BY id ASC`)
      .all(taskId) as { id: number; task_id: string; ts: number; raw: string }[];
    return rows.map((r) => ({ id: r.id, taskId: r.task_id, ts: r.ts, raw: JSON.parse(r.raw) }));
  }

  // Called when a conversation is deleted from the sidebar — removes every
  // task row AgentHub tracked for that session (and their events), so a
  // deleted conversation doesn't reappear via the "tracked but not yet on
  // disk" fallback path in main.ts's listConversations().
  deleteBySessionId(agent: AgentKind, sessionId: string) {
    const ids = this.db
      .prepare(`SELECT id FROM tasks WHERE agent = ? AND session_id = ?`)
      .all(agent, sessionId) as { id: string }[];
    const del = this.db.transaction((taskIds: string[]) => {
      for (const id of taskIds) {
        this.db.prepare(`DELETE FROM task_events WHERE task_id = ?`).run(id);
        this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
      }
    });
    del(ids.map((r) => r.id));
    this.db.prepare(`DELETE FROM conversation_titles WHERE agent = ? AND session_id = ?`).run(agent, sessionId);
    this.db.prepare(`DELETE FROM conversation_pins WHERE agent = ? AND session_id = ?`).run(agent, sessionId);
  }

  close() {
    this.db.close();
  }
}
