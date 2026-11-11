// Smoke test the built renderer with its real preload/IPC bridge and xterm.
// Run as a normal Electron app, never against the user's real database.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const { IPC } = require('../dist-electron/src/shared/ipc');
const { compareConversations } = require('../dist-electron/src/shared/conversationOrder');
const now = new Date().toISOString();
const conversations = [
  { agent: 'codex', sessionId: 'codex-session', cwd: '/tmp', title: '接续 Claude 测试', status: 'needs_attention', taskId: 'task-codex', path: '/tmp/codex.jsonl', createdAt: now, lastActivityAt: now },
  { agent: 'claude', sessionId: 'old-pinned', cwd: '/tmp', title: '很久以前置顶的会话', pinnedAt: 10, status: 'succeeded', taskId: null, path: '/tmp/claude.jsonl', createdAt: '2020-01-01', lastActivityAt: '2020-01-01' },
];
const spawnCalls = [];
let win;
let timeout;

async function waitFor(expression) {
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${expression}`);
}

app.whenReady().then(async () => {
  timeout = setTimeout(() => { console.error('UI smoke test timeout'); app.exit(1); }, 20000);
  ipcMain.handle(IPC.conversationsList, () => [...conversations].sort(compareConversations));
  ipcMain.handle(IPC.conversationsTranscript, () => []);
  ipcMain.handle(IPC.conversationsSetPinned, (_event, input) => {
    const conversation = conversations.find((c) => c.agent === input.agent && c.sessionId === input.sessionId);
    conversation.pinnedAt = input.pinned ? Date.now() : null;
  });
  ipcMain.handle(IPC.ptySpawn, (_event, payload) => { spawnCalls.push(payload); return 'PTY test buffer\r\n'; });
  ipcMain.on(IPC.ptyResize, () => {});
  ipcMain.on(IPC.ptyWrite, () => {});
  ipcMain.on(IPC.ptyKill, () => {});
  win = new BrowserWindow({ show: false, width: 1000, height: 700,
    webPreferences: { preload: path.join(__dirname, '../dist-electron/electron/preload.js'), contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(__dirname, '../dist-renderer/index.html'));
  await waitFor(`document.querySelectorAll('.conv-item').length === 2`);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.conv-item-title').textContent`), '很久以前置顶的会话');
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.conv-item')).find(e => e.textContent.includes('接续 Claude')).click()`);
  await waitFor(`!!Array.from(document.querySelectorAll('.mode-toggle button')).find(e => e.textContent.includes('终端') && !e.disabled)`);
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.mode-toggle button')).find(e => e.textContent.includes('终端')).click()`);
  await waitFor(`!!document.querySelector('.terminal-container .xterm')`);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].sessionId, 'codex-session');
  assert.equal(spawnCalls[0].key, 'codex:codex-session');
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.conv-item')).find(e => e.textContent.includes('接续 Claude')).querySelector('[aria-label="置顶会话"]').click()`);
  await waitFor(`document.querySelector('.conv-item-title').textContent === '接续 Claude 测试'`);
  await win.webContents.executeJavaScript(`document.querySelector('.conv-item [aria-label="取消置顶"]').click()`);
  await waitFor(`document.querySelector('.conv-item-title').textContent === '很久以前置顶的会话'`);
  console.log('Renderer terminal button, real xterm mount, same session ID, pin/unpin sorting and old pin visibility passed');
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => {
  console.error(error);
  if (timeout) clearTimeout(timeout);
  app.exit(1);
});
