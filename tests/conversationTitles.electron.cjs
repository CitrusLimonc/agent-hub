// better-sqlite3 is built for Electron's ABI. This check runs under
// ELECTRON_RUN_AS_NODE, against a temporary database rather than user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskStore } = require('../dist-electron/src/core/taskStore');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-titles-'));
let store;
try {
  const dbPath = path.join(root, 'test.sqlite');
  store = new TaskStore(dbPath);
  const task = store.createTask({ agent: 'claude', cwd: root, prompt: '原始要求', autoFailover: false });
  store.setSessionId(task.id, 'same-id');
  const title = '完整的自定义标题'.repeat(40);
  assert.equal(store.setConversationTitle('claude', 'same-id', ` ${title} `), title);
  store.setConversationTitle('codex', 'same-id', '不同 agent 的独立标题');
  store.setConversationPinned('claude', 'same-id', true, '/tmp/old-session.jsonl');
  const pinnedAt = store.getConversationPins().get('claude:same-id').pinnedAt;
  store.setConversationPinned('claude', 'same-id', true, null);
  assert.equal(store.getConversationPins().get('claude:same-id').pinnedAt, pinnedAt);
  store.setConversationPinned('codex', 'same-id', true, null);
  store.close();
  store = new TaskStore(dbPath);
  assert.equal(store.getConversationTitles().get('claude:same-id'), title);
  assert.equal(store.getConversationTitles().get('codex:same-id'), '不同 agent 的独立标题');
  assert.equal(store.getConversationPins().get('claude:same-id').path, '/tmp/old-session.jsonl');
  assert.equal(store.getConversationPins().get('claude:same-id').pinnedAt, pinnedAt);
  assert.ok(store.getConversationPins().has('codex:same-id'));
  store.setConversationPinned('codex', 'same-id', false, null);
  assert.ok(!store.getConversationPins().has('codex:same-id'));
  assert.throws(() => store.setConversationPinned('claude', '', true, null), /无效/);
  assert.throws(() => store.setConversationPinned('claude', 'same-id', 'yes', null), /无效/);
  assert.equal(store.getTask(task.id).prompt, '原始要求');
  store.setConversationTitle('claude', 'same-id', "更新标题 ' ; DROP TABLE tasks; --");
  assert.ok(store.getTask(task.id));
  assert.throws(() => store.setConversationTitle('claude', '', '标题'), /无效/);
  assert.throws(() => store.setConversationTitle('other', 'same-id', '标题'), /无效/);
  assert.throws(() => store.setConversationTitle('claude', 'same-id', 'a'.repeat(501)), /500/);
  assert.equal(store.setConversationTitle('claude', 'same-id', '   '), null);
  assert.ok(!store.getConversationTitles().has('claude:same-id'));
  store.setConversationTitle('claude', 'same-id', '重新命名');
  store.deleteBySessionId('claude', 'same-id');
  assert.ok(!store.getConversationTitles().has('claude:same-id'));
  assert.equal(store.getConversationTitles().get('codex:same-id'), '不同 agent 的独立标题');
  assert.ok(!store.getConversationPins().has('claude:same-id'));
  console.log('SQLite title persistence, reset, agent isolation and deletion passed');
} finally {
  store?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
