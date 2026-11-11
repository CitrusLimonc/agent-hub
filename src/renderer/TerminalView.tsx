import { useEffect, useRef } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ConversationSummary } from '../core/types';
import { conversationKey } from './ConversationSidebar';

interface Props {
  conversation: ConversationSummary;
  theme: 'dark' | 'light';
}

// `background: 'transparent'` + `allowTransparency: true` was the first
// attempt here — in theory that should let the app's own CSS background
// show through so this file wouldn't need to track a duplicate background
// color at all. In practice xterm still painted an opaque black canvas
// regardless (verified: the resolved theme object logged out correctly with
// `background: "transparent"`, so this isn't an app-side bug — xterm's
// canvas/WebGL renderer just doesn't seem to honor it here). Explicit solid
// colors matching styles.css's `:root`/`[data-theme='light']` `--bg-panel`
// are the reliable fallback — kept separate from the CSS variables rather
// than read at runtime because xterm's theme option takes concrete colors,
// not CSS custom properties.
const DARK_XTERM_THEME: ITheme = {
  background: '#1e1e20',
  foreground: '#eaeaea',
  cursor: '#eaeaea',
  cursorAccent: '#1e1e20',
  selectionBackground: 'rgba(121, 192, 255, 0.3)',
  black: '#1e1e20',
  red: '#ff8a8a',
  green: '#7dffb0',
  yellow: '#ffd558',
  blue: '#79c0ff',
  magenta: '#cb9dff',
  cyan: '#79e0ff',
  white: '#eaeaea',
  brightBlack: '#6b6b6f',
  brightRed: '#ff8a8a',
  brightGreen: '#7dffb0',
  brightYellow: '#ffd558',
  brightBlue: '#79c0ff',
  brightMagenta: '#cb9dff',
  brightCyan: '#79e0ff',
  brightWhite: '#ffffff',
};

const LIGHT_XTERM_THEME: ITheme = {
  background: '#f5f5f7',
  foreground: '#1d1d1f',
  cursor: '#1d1d1f',
  cursorAccent: '#f5f5f7',
  selectionBackground: 'rgba(10, 132, 255, 0.2)',
  black: '#1d1d1f',
  red: '#c53030',
  green: '#15803d',
  yellow: '#a16207',
  blue: '#0a66d1',
  magenta: '#9333ea',
  cyan: '#0e7490',
  white: '#3a3a3c',
  brightBlack: '#6e6e73',
  brightRed: '#dc2626',
  brightGreen: '#16a34a',
  brightYellow: '#ca8a04',
  brightBlue: '#0a84ff',
  brightMagenta: '#a855f7',
  brightCyan: '#0891b2',
  brightWhite: '#000000',
};

function themeFor(theme: 'dark' | 'light'): ITheme {
  return theme === 'light' ? LIGHT_XTERM_THEME : DARK_XTERM_THEME;
}

// Renders the CLI's *actual* interactive TUI via node-pty (see
// ptyManager.ts) — this is the "identical to the terminal" mode, as opposed
// to ConversationView's chat-bubble rendering of the headless --json/-p
// event stream. Deliberately doesn't kill the pty on unmount: switching back
// to chat mode or to another conversation leaves this session running in the
// main process, and remounting replays its buffered output (see
// spawnPty/attachPty) instead of showing a blank terminal.
export default function TerminalView({ conversation, theme }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const key = conversationKey(conversation);
    const term = new Terminal({
      convertEol: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      scrollback: 5000,
      theme: themeFor(theme),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    termRef.current = term;
    fitAddon.fit();

    let disposed = false;
    let ready = false;
    term.write('\x1b[90m[正在准备终端；如有后台任务，将先停止后接续当前会话…]\x1b[0m\r\n');

    window.agentHub
      .spawnPty({
        key,
        agent: conversation.agent,
        cwd: conversation.cwd,
        sessionId: conversation.sessionId || null,
      })
      .then((replayBuffer) => {
        if (disposed) return;
        ready = true;
        if (replayBuffer) term.write(replayBuffer);
        fitAddon.fit();
        window.agentHub.resizePty({ key, cols: term.cols, rows: term.rows });
        term.focus();
      })
      .catch((error) => {
        if (!disposed) term.write(`\r\n[无法打开终端: ${String(error)}]\r\n`);
      });

    const offOutput = window.agentHub.onPtyOutput((payload) => {
      if (payload.key !== key) return;
      term.write(payload.data);
    });
    const offExit = window.agentHub.onPtyExit((payload) => {
      if (payload.key !== key) return;
      term.write(`\r\n\x1b[90m[进程已退出,退出码 ${payload.code}]\x1b[0m\r\n`);
    });

    const dataDisposable = term.onData((data) => {
      if (!ready) return;
      window.agentHub.writePty({ key, data });
    });

    // IME punctuation fix (verified via instrumentation): with a Chinese IME
    // active, pressing , . etc. in this Electron build fires keydown with
    // the REAL keyCode (188…) and isComposing=false — not the keyCode-229
    // "IME is handling this key" signal real Chrome browsers send. xterm's
    // own keydown handler therefore treats it as a plain printable key,
    // preventDefaults, and sends the raw ASCII "," — the IME's full-width
    // conversion ("，") never happens, because that conversion is delivered
    // AFTER keydown via insertText, which the preventDefault killed.
    // Fix: intercept printable, unmodified keydowns BEFORE xterm (capture
    // phase on the container, which sits above xterm's textarea listener)
    // and stopImmediatePropagation WITHOUT preventDefault. The browser's
    // default text-input pipeline then runs: IME-converted text arrives at
    // the helper textarea via insertText, which xterm's _inputEvent handler
    // already knows how to send (this is exactly the code path real-IME
    // keyCode-229 keys take); plain ASCII instead arrives via keypress,
    // which xterm's _keyPress handler sends. Either way exactly one copy of
    // the right character is emitted — xterm guards double-sends with
    // _keyDownSeen/_keyPressHandled.
    const imePunctuationFix = (ev: KeyboardEvent) => {
      if (ev.isComposing) return; // mid-composition keys: xterm already defers to the IME
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return; // shortcuts / dead keys: xterm's own path
      if (ev.key.length !== 1) return; // Enter/Backspace/arrows/…: xterm's own path
      ev.stopImmediatePropagation();
    };
    container.addEventListener('keydown', imePunctuationFix, true);

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      window.agentHub.resizePty({ key, cols: term.cols, rows: term.rows });
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      offOutput();
      offExit();
      dataDisposable.dispose();
      container.removeEventListener('keydown', imePunctuationFix, true);
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `theme` is
    // handled by the effect below without tearing down the pty connection.
  }, [conversation.agent, conversation.cwd, conversation.sessionId, conversation.taskId]);

  // Applying a theme change doesn't need to touch the pty/session at all —
  // xterm supports live-updating `.options.theme`, so this is a separate,
  // lighter effect from the one above (which owns the pty's lifecycle).
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = themeFor(theme);
  }, [theme]);

  return <div ref={containerRef} className="terminal-container" />;
}
