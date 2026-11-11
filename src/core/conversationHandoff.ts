import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TaskStore } from './taskStore';
import type { TaskRunner } from './taskRunner';
import type { SwitchToCodexPayload, SwitchToCodexResult } from '../shared/ipc';
import { buildClaudeToCodexPrompt, parseClaudeSession, readClaudeProjectMemory, renderClaudeMemory } from './claudeMemory';
import { buildCodexToClaudePrompt, parseCodexSession, renderCodexMemory } from './codexMemory';

/** Creates a new Codex session, never rewrites either CLI's native log. The
 * snapshot and its path in the persisted task prompt survive app restarts. */
export class ConversationHandoff {
  private switching = new Set<string>();

  constructor(
    private store: Pick<TaskStore, 'listTasks'>,
    private runner: Pick<TaskRunner, 'start' | 'isSessionRunning'>,
    private claudeProjectsDir: string,
    private codexSessionsDir: string,
    private handoffsDir: string,
    private stopTerminal: (key: string) => Promise<void>,
  ) {}

  isSwitching(sessionId: string): boolean {
    return this.switching.has(sessionId);
  }

  async switchToCodex(input: SwitchToCodexPayload): Promise<SwitchToCodexResult> {
    if (!input || typeof input.sessionId !== 'string' || !/^[\w-]+$/.test(input.sessionId) ||
        typeof input.path !== 'string' || typeof input.cwd !== 'string' ||
        typeof input.instruction !== 'string' || input.instruction.length > 8000) {
      throw new Error('无效的会话交接参数（交接要求最多 8000 字符）。');
    }
    if (this.switching.has(input.sessionId)) throw new Error('此会话正在切换到 Codex，请勿重复提交。');
    this.switching.add(input.sessionId);
    try {
      if (this.runner.isSessionRunning('claude', input.sessionId)) {
        throw new Error('Claude 当前任务仍在运行，请等待结束后再切换到 Codex。');
      }
      const source = path.resolve(input.path);
      const relative = path.relative(path.resolve(this.claudeProjectsDir), source).split(path.sep);
      if (relative.length !== 2 || relative[0] === '..' || relative[1] !== `${input.sessionId}.jsonl`) {
        throw new Error('请选择有效的 Claude 历史会话。');
      }
      // Validate before stopping the terminal; then read again after exit
      // so the snapshot includes its final persisted turn.
      const before = parseClaudeSession(await fs.readFile(source, 'utf8'), input.sessionId);
      if (path.resolve(before.cwd) !== path.resolve(input.cwd) || !path.isAbsolute(before.cwd)) {
        throw new Error('会话工作目录不匹配，请重新打开会话。');
      }
      if (!(await fs.stat(before.cwd)).isDirectory()) throw new Error('会话工作目录不存在。');
      await this.stopTerminal(`claude:${input.sessionId}`);
      const memory = parseClaudeSession(await fs.readFile(source, 'utf8'), input.sessionId);
      if (path.resolve(memory.cwd) !== path.resolve(before.cwd)) throw new Error('Claude 会话工作目录已变化，请重新打开会话。');
      const files = await readClaudeProjectMemory(path.dirname(source));
      const contextPath = path.join(this.handoffsDir, `${randomUUID()}.md`);
      await fs.mkdir(this.handoffsDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(contextPath, renderClaudeMemory(memory, files, input.sessionId), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const sourceTask = this.store.listTasks().find((t) => t.agent === 'claude' && t.sessionId === input.sessionId);
      const task = this.runner.start('codex', memory.cwd, buildClaudeToCodexPrompt(memory, contextPath, input.instruction), {
        handoffFromTaskId: sourceTask?.id,
      });
      return {
        task, title: `接续 Claude：${memory.title}`, contextPath,
        entryCount: memory.entries.length, memoryFileCount: files.length, skippedLines: memory.skippedLines,
      };
    } finally {
      this.switching.delete(input.sessionId);
    }
  }

  async switchToClaude(input: SwitchToCodexPayload): Promise<SwitchToCodexResult> {
    if (!input || typeof input.sessionId !== 'string' || !/^[\w-]+$/.test(input.sessionId) ||
        typeof input.path !== 'string' || typeof input.cwd !== 'string' ||
        typeof input.instruction !== 'string' || input.instruction.length > 8000) {
      throw new Error('无效的会话交接参数（交接要求最多 8000 字符）。');
    }
    if (this.switching.has(input.sessionId)) throw new Error('此会话正在切换，请勿重复提交。');
    this.switching.add(input.sessionId);
    try {
      if (this.runner.isSessionRunning('codex', input.sessionId)) {
        throw new Error('Codex 当前任务仍在运行，请等待结束后再切换到 Claude。');
      }
      const source = path.resolve(input.path);
      if (!source.startsWith(path.resolve(this.codexSessionsDir) + path.sep) || !source.endsWith('.jsonl')) {
        throw new Error('请选择有效的 Codex 历史会话。');
      }
      const before = await parseCodexSession(source, input.sessionId);
      if (path.resolve(before.cwd) !== path.resolve(input.cwd) || !path.isAbsolute(before.cwd)) {
        throw new Error('会话工作目录不匹配，请重新打开会话。');
      }
      if (!(await fs.stat(before.cwd)).isDirectory()) throw new Error('会话工作目录不存在。');
      await this.stopTerminal(`codex:${input.sessionId}`);
      const memory = await parseCodexSession(source, input.sessionId);
      if (path.resolve(memory.cwd) !== path.resolve(before.cwd)) throw new Error('Codex 会话工作目录已变化，请重新打开会话。');
      const contextPath = path.join(this.handoffsDir, `${randomUUID()}.md`);
      await fs.mkdir(this.handoffsDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(contextPath, renderCodexMemory(memory, input.sessionId), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const sourceTask = this.store.listTasks().find((t) => t.agent === 'codex' && t.sessionId === input.sessionId);
      const task = this.runner.start('claude', memory.cwd, buildCodexToClaudePrompt(memory, contextPath, input.instruction), {
        handoffFromTaskId: sourceTask?.id,
      });
      return {
        task, title: `接续 Codex：${memory.title}`, contextPath,
        entryCount: memory.entries.length, memoryFileCount: 0, skippedLines: memory.skippedLines,
      };
    } finally {
      this.switching.delete(input.sessionId);
    }
  }
}
