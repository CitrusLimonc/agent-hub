const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseClaudeSession, renderClaudeMemory, buildClaudeToCodexPrompt } = require('../dist-electron/src/core/claudeMemory');
const { ConversationHandoff } = require('../dist-electron/src/core/conversationHandoff');
const { TaskRunner } = require('../dist-electron/src/core/taskRunner');

const sessionId = 'claude-session-1';
const jsonl = (records) => records.map((r) => JSON.stringify({ sessionId, ...r })).join('\n');
const user = (uuid, parentUuid, text, extra = {}) => ({ type: 'user', uuid, parentUuid, cwd: '/tmp/project', message: { content: text }, ...extra });
const assistant = (uuid, parentUuid, content) => ({ type: 'assistant', uuid, parentUuid, message: { content } });

test('active branch, compaction summaries, full tools, attachments and malformed lines', () => {
  const longOutput = '完整输出'.repeat(10000);
  const records = [
    user('u1', null, '实现登录功能'),
    assistant('a1', 'u1', [{ type: 'text', text: '先检查代码' }, { type: 'thinking', thinking: 'PRIVATE_THINKING' }]),
    user('abandoned', 'a1', '被回退的旧要求'),
    assistant('old', 'abandoned', [{ type: 'text', text: '不应带入的分支' }]),
    user('u2', 'a1', '保留登录方式'),
    assistant('a2', 'u2', [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: '调用详情'.repeat(300) } }]),
    user('t1', 'a2', [{ type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: longOutput }] }]),
    { type: 'summary', summary: '需要保留的旧摘要' },
    { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', parentUuid: null, logicalParentUuid: 't1' },
    user('compact', 'boundary', '压缩后的用户目标和已完成工作', { isCompactSummary: true }),
    user('u3', 'compact', [{ type: 'image', source: { type: 'base64', data: 'PRIVATE_BASE64' } }, { type: 'text', text: '下一步检查' }]),
    user('side', 'u3', '后台任务不应混入', { isSidechain: true }),
    user('other', null, '另一个会话', { sessionId: 'different-session' }),
    { type: 'ai-title', aiTitle: '登录功能交接' },
  ];
  const memory = parseClaudeSession(jsonl(records) + '\n{broken\n', sessionId);
  const rendered = renderClaudeMemory(memory, [{ name: 'MEMORY.md', text: '默认使用 pnpm' }], sessionId);
  assert.equal(memory.title, '登录功能交接');
  assert.equal(memory.skippedLines, 1);
  for (const text of [longOutput, '调用详情'.repeat(300), '需要保留的旧摘要', '压缩后的用户目标', '默认使用 pnpm', '非文本附件']) {
    assert.ok(rendered.includes(text), `Missing ${text.slice(0, 20)}`);
  }
  for (const text of ['被回退', '不应带入', '后台任务不应混入', '另一个会话', 'PRIVATE_THINKING', 'PRIVATE_BASE64']) {
    assert.ok(!rendered.includes(text), `Unexpected ${text}`);
  }
  const prompt = buildClaudeToCodexPrompt(memory, '/tmp/path with spaces/context.md', '继续测试');
  assert.ok(Buffer.byteLength(prompt) < 100000);
  assert.ok(prompt.includes('"/tmp/path with spaces/context.md"'));
  assert.ok(prompt.endsWith('继续测试'));
});

test('logs without UUIDs remain readable; empty or unrelated logs fail', () => {
  const memory = parseClaudeSession(jsonl([
    { type: 'user', cwd: '/tmp/project', message: { content: '旧格式目标' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '旧格式回复' }] } },
  ]), sessionId);
  assert.equal(memory.entries.length, 2);
  assert.throws(() => parseClaudeSession('broken\n', sessionId), /工作目录/);
  assert.throws(() => parseClaudeSession(jsonl([user('u1', null, 'wrong', { sessionId: 'other' })]), sessionId), /工作目录/);
  assert.throws(() => parseClaudeSession(jsonl([{ type: 'system', cwd: '/tmp/project' }]), sessionId), /没有可交接/);
});

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agenthub-handoff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  const project = path.join(projects, 'encoded-project');
  const cwd = path.join(root, 'workspace');
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(cwd);
  const source = path.join(project, `${sessionId}.jsonl`);
  const original = jsonl([user('u1', null, '完成原始任务', { cwd })]);
  await fs.writeFile(source, original);
  const launches = [];
  const stops = [];
  const runner = options.runner || {
    isSessionRunning: () => !!options.busy,
    start(agent, dir, prompt, opts) {
      launches.push({ agent, cwd: dir, prompt, opts });
      return { id: 'target-task', agent, cwd: dir, prompt, status: 'running', sessionId: null };
    },
  };
  const handoff = new ConversationHandoff(
    { listTasks: () => options.tasks || [] }, runner, projects, path.join(root, 'handoffs'),
    async (key) => { stops.push(key); await options.onStop?.({ source, cwd }); },
  );
  return { root, project, cwd, source, original, launches, stops, handoff,
    input: { sessionId, path: source, cwd, instruction: '' } };
}

test('external session is snapshotted after terminal exit with recursive project memory', async (t) => {
  const f = await fixture(t, { onStop: async ({ source, cwd }) => {
    await fs.appendFile(source, '\n' + jsonl([user('u2', 'u1', '退出前最后一条', { cwd })]));
  } });
  await fs.mkdir(path.join(f.project, 'memory', 'topics'), { recursive: true });
  await fs.writeFile(path.join(f.project, 'memory', 'MEMORY.md'), '项目使用 SQLite');
  await fs.writeFile(path.join(f.project, 'memory', 'topics', 'auth.md'), '授权方案');
  const result = await f.handoff.switchToCodex(f.input);
  const context = await fs.readFile(result.contextPath, 'utf8');
  assert.equal(result.memoryFileCount, 2);
  assert.equal(result.entryCount, 2);
  assert.ok(context.includes('退出前最后一条'));
  assert.ok(context.includes('项目使用 SQLite'));
  assert.ok(context.includes('topics/auth.md'));
  assert.equal((await fs.stat(result.contextPath)).mode & 0o777, 0o600);
  assert.deepEqual(f.stops, [`claude:${sessionId}`]);
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].agent, 'codex');
  assert.equal(f.launches[0].cwd, f.cwd);
  assert.ok(f.launches[0].prompt.includes(result.contextPath));
  assert.equal(f.launches[0].opts.handoffFromTaskId, undefined);
  assert.ok((await fs.readFile(f.source, 'utf8')).startsWith(f.original));
  assert.equal(f.handoff.isSwitching(sessionId), false);
});

test('known source task is linked and original session remains untouched', async (t) => {
  const f = await fixture(t, { tasks: [{ agent: 'claude', sessionId, id: 'source-task' }] });
  await f.handoff.switchToCodex({ ...f.input, instruction: '只继续验证' });
  assert.equal(f.launches[0].opts.handoffFromTaskId, 'source-task');
  assert.ok(f.launches[0].prompt.endsWith('只继续验证'));
  assert.equal(await fs.readFile(f.source, 'utf8'), f.original);
});

test('busy sources, invalid paths/cwd, unreadable memory and duplicate submissions never launch Codex', async (t) => {
  const busy = await fixture(t, { busy: true });
  await assert.rejects(busy.handoff.switchToCodex(busy.input), /仍在运行/);
  assert.equal(busy.stops.length, 0);
  assert.equal(busy.launches.length, 0);
  const f = await fixture(t);
  await assert.rejects(f.handoff.switchToCodex({ ...f.input, path: path.join(f.root, `${sessionId}.jsonl`) }), /有效的 Claude/);
  await assert.rejects(f.handoff.switchToCodex({ ...f.input, cwd: f.root }), /工作目录不匹配/);
  await assert.rejects(f.handoff.switchToCodex({ ...f.input, instruction: 'a'.repeat(8001) }), /无效/);
  assert.equal(f.stops.length, 0);
  await fs.writeFile(path.join(f.project, 'memory'), 'not a directory');
  await assert.rejects(f.handoff.switchToCodex(f.input), /ENOTDIR/);
  assert.equal(f.launches.length, 0);
  assert.equal(f.handoff.isSwitching(sessionId), false);

  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const concurrent = await fixture(t, { onStop: () => pending });
  const first = concurrent.handoff.switchToCodex(concurrent.input);
  await assert.rejects(concurrent.handoff.switchToCodex(concurrent.input), /请勿重复/);
  release();
  await first;
  assert.equal(concurrent.launches.length, 1);
});

test('real task runner launches a fresh Codex process in the same cwd with the saved context', async (t) => {
  const rows = new Map();
  const events = [];
  const store = {
    createTask(input) {
      const row = { ...input, id: 'integration-task', sessionId: null, status: 'running' };
      rows.set(row.id, row);
      return { ...row };
    },
    getTask(id) { return rows.get(id); },
    appendEvent(id, raw) { events.push(raw); },
    setSessionId(id, sid) { rows.get(id).sessionId = sid; },
    setLastMessage(id, msg) { rows.get(id).lastMessage = msg; },
    updateStatus(id, status) { rows.get(id).status = status; },
  };
  const runner = new TaskRunner(store, 5000);
  t.after(() => runner.killAll());
  const f = await fixture(t, { runner });
  const bin = path.join(f.root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'codex'), `#!${process.execPath}\nconst args = process.argv.slice(2);\nprocess.stdout.write(JSON.stringify({type:'thread.started',thread_id:'new-codex-session'})+'\\n');\nprocess.stdout.write(JSON.stringify({type:'invocation',args,cwd:process.cwd()})+'\\n');\nprocess.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'已读取交接'}})+'\\n');\n`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const done = new Promise((resolve) => runner.once('status', resolve));
  const result = await f.handoff.switchToCodex(f.input);
  const status = await done;
  assert.equal(status.status, 'succeeded');
  const invocation = events.find((e) => e.type === 'invocation');
  assert.equal(invocation.cwd, await fs.realpath(f.cwd));
  assert.equal(invocation.args[0], 'exec');
  assert.ok(!invocation.args.includes('resume'));
  assert.ok(!invocation.args.includes(sessionId));
  assert.ok(invocation.args.at(-1).includes(result.contextPath));
  assert.equal(rows.get('integration-task').sessionId, 'new-codex-session');
  assert.equal(rows.get('integration-task').lastMessage, '已读取交接');
});

test('custom titles persist across restarts in the actual Electron SQLite database', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(require('electron'), [path.join(__dirname, 'conversationTitles.electron.cjs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.ok(result.stdout.includes('passed'));
});

test('running Codex handoff can be taken over in a real interactive PTY', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(require('electron'), [path.join(__dirname, 'terminalTakeover.electron.cjs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.ok(result.stdout.includes('passed'));
});
