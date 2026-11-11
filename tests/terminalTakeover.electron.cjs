const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { TaskStore } = require('../dist-electron/src/core/taskStore');
const { TaskRunner } = require('../dist-electron/src/core/taskRunner');
const { installFailoverController } = require('../dist-electron/src/core/failoverController');
const { attachPty, writePty, killAllPty, ptyEvents } = require('../dist-electron/src/core/ptyManager');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agenthub-terminal-'));
  const oldPath = process.env.PATH;
  let store;
  let runner;
  try {
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin);
    // A real headless subprocess that stays alive in needs_attention, then
    // a real PTY invocation of the same fake CLI that accepts typed input.
    await fs.writeFile(path.join(bin, 'codex'), `#!${process.execPath}\n
const fs = require('fs');
if (process.argv[2] === 'exec') {
  console.log(JSON.stringify({type:'thread.started',thread_id:'takeover-session'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'Permission denied'}}));
  process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(path.join(root, 'headless-exited'))}, 'yes'); process.exit(0); }, 150));
  setInterval(() => {}, 1000);
} else {
  if (!fs.existsSync(${JSON.stringify(path.join(root, 'headless-exited'))})) process.exit(3);
  console.log('PTY_READY ' + process.argv.slice(2).join(' '));
  process.stdin.on('data', data => console.log('RECEIVED ' + data.toString().trim()));
}
`, { mode: 0o700 });
    process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    store = new TaskStore(path.join(root, 'tasks.sqlite'));
    runner = new TaskRunner(store, 10000);
    installFailoverController(store, runner);
    const attention = new Promise((resolve) => runner.on('status', (event) => {
      if (event.status === 'needs_attention') resolve();
    }));
    const task = runner.start('codex', root, '接续 Claude 会话测试');
    await attention;
    assert.equal(store.getTask(task.id).status, 'needs_attention');
    const first = runner.stopSessionForTerminal('codex', 'takeover-session');
    assert.equal(runner.stopSessionForTerminal('codex', 'takeover-session'), first);
    assert.throws(() => runner.resume('codex', root, 'takeover-session', 'race'), /正在切换到终端/);
    await first;
    assert.equal(store.getTask(task.id).status, 'killed');
    assert.equal(store.listTasks().length, 1, 'manual interruption must not auto-failover to Claude');
    assert.ok(!runner.isSessionRunning('codex', 'takeover-session'));
    const key = 'codex:takeover-session';
    let output = '';
    let sent = false;
    const received = new Promise((resolve) => ptyEvents.on('data', (eventKey, data) => {
      if (eventKey !== key) return;
      output += data;
      if (output.includes('PTY_READY') && !sent) { sent = true; writePty(key, 'hello-terminal\r'); }
      if (output.includes('RECEIVED hello-terminal')) resolve();
    }));
    attachPty(key, 'codex', root, 'takeover-session');
    await received;
    assert.ok(output.includes('PTY_READY resume takeover-session'));
    console.log('Running needs_attention task stopped, no failover, same-session PTY resume and keyboard input passed');
  } finally {
    runner?.killAll();
    killAllPty();
    store?.close();
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
