import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ConversationSummary, TaskStatus } from '../core/types';
import type { SwitchToCodexResult } from '../shared/ipc';
import { formatEvent, truncate } from '../shared/eventFormat';
import { conversationKey } from './ConversationSidebar';
import TerminalView from './TerminalView';

interface Props {
  conversation: ConversationSummary;
  initialMode?: ViewMode;
  theme: 'dark' | 'light';
  onSwitchToCodex(result: SwitchToCodexResult): void;
  onSwitchToClaude(result: SwitchToCodexResult): void;
  handoffNotice?: string;
}

type ViewMode = 'chat' | 'terminal';

/** Remembers, per conversation, which mode the user last viewed it in — so
 * reopening a conversation they were driving through the embedded terminal
 * lands them straight back in terminal mode instead of chat (App.tsx reads
 * this in selectConversation). Same localStorage approach as the theme. */
export function rememberedMode(c: ConversationSummary): ViewMode {
  try {
    return localStorage.getItem(`agenthub-mode:${conversationKey(c)}`) === 'terminal' ? 'terminal' : 'chat';
  } catch {
    return 'chat';
  }
}

// Renders one conversation as a chat transcript and lets you continue it.
// `history` (fetched once per conversation, from disk via getTranscript) and
// `live` (built turn-by-turn from formatEvent() as a resume spawns) are two
// separate arrays concatenated at render time rather than one merged list —
// there's no need to reconcile them since history never changes underneath
// a mounted conversation and live only ever grows.
//
// `currentTaskId` tracks which task's events belong to *this* conversation
// right now. It has to be a ref, not state: the onEvent/onStatus listeners
// below are registered once and read it on every event, so a state variable
// would only ever see the value from the render that registered the
// listener (a classic stale-closure trap) — see React docs on this pattern.
export default function ConversationView({ conversation, initialMode = 'chat', theme, onSwitchToCodex, onSwitchToClaude, handoffNotice }: Props) {
  const [mode, setMode] = useState<ViewMode>(initialMode);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [live, setLive] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [taskStatus, setTaskStatus] = useState<TaskStatus | null>(conversation.status);
  const [showHandoff, setShowHandoff] = useState(false);
  const [handoffInstruction, setHandoffInstruction] = useState('');
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const currentTaskId = useRef<string | null>(null);
  // The ChatMessage bubble currently being filled in token-by-token by
  // Claude's `stream_event` deltas (see claudeAdapter.ts's
  // --include-partial-messages). Mutated in place and re-committed via
  // `setLive((prev) => [...prev])` on every delta — rebuilding the whole
  // message object per token would be wasteful for a fast stream.
  const streamingMsg = useRef<ChatMessage | null>(null);

  useEffect(() => {
    setHistory([]);
    setLive([]);
    setSending(false);
    setTaskStatus(conversation.status);
    currentTaskId.current = conversation.taskId;
    streamingMsg.current = null;

    if (!conversation.path) {
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    window.agentHub
      .getTranscript({ agent: conversation.agent, path: conversation.path })
      .then((msgs) => {
        if (!cancelled) setHistory(msgs);
      })
      .catch((err) => { if (!cancelled) setError(String(err)); })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversation.agent, conversation.sessionId, conversation.taskId, conversation.path]);

  useEffect(() => {
    setTaskStatus(conversation.status);
  }, [conversation.status]);

  useEffect(() => {
    const offEvent = window.agentHub.onEvent(({ taskId, raw }: { taskId: string; raw: any }) => {
      if (taskId !== currentTaskId.current) return;

      // Claude's stream_event deltas arrive ahead of (and duplicate) the
      // complete `assistant` message — build the bubble live from deltas,
      // then only pull tool_use calls (never streamed token-by-token) out
      // of the complete message once it shows up.
      if (conversation.agent === 'claude' && raw.type === 'stream_event') {
        const evt = raw.event;
        if (evt?.type === 'content_block_start' && evt.content_block?.type === 'text') {
          const msg: ChatMessage = { role: 'assistant', text: '' };
          streamingMsg.current = msg;
          setLive((prev) => [...prev, msg]);
        } else if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          if (streamingMsg.current) {
            streamingMsg.current.text += evt.delta.text;
            setLive((prev) => [...prev]);
          }
        } else if (evt?.type === 'content_block_stop') {
          streamingMsg.current = null;
        }
        return;
      }
      if (conversation.agent === 'claude' && raw.type === 'assistant') {
        const content = raw.message?.content;
        const toolCalls = Array.isArray(content) ? content.filter((c: any) => c.type === 'tool_use') : [];
        if (toolCalls.length) {
          const msgs: ChatMessage[] = toolCalls.map((c: any) => ({
            role: 'assistant',
            text: `→ ${c.name}(${truncate(JSON.stringify(c.input), 200)})`,
          }));
          setLive((prev) => [...prev, ...msgs]);
        }
        return;
      }

      const line = formatEvent(conversation.agent, raw);
      if (!line) return;
      setLive((prev) => [...prev, { role: 'assistant', text: line }]);
    });
    const offStatus = window.agentHub.onStatus(({ taskId, status }) => {
      if (taskId !== currentTaskId.current) return;
      setTaskStatus(status);
      if (status !== 'running' && status !== 'needs_attention') setSending(false);
    });
    return () => {
      offEvent();
      offStatus();
    };
  }, [conversation.agent]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, live]);

  // `sending` (cleared only by the onStatus handler above, once the current
  // task hits a terminal status) gates the input until the previous turn
  // has genuinely finished — sending a resume for the same session while
  // one is still in flight was verified to fail or silently no-op (both
  // CLIs write to the same session file; there's no queueing).
  const busy = sending || taskStatus === 'running' || taskStatus === 'needs_attention';
  const canSend = !!conversation.sessionId && !busy && !switching && input.trim().length > 0;

  // setMode + persist the choice so the next time this conversation is
  // opened from the sidebar it starts in the same mode (see rememberedMode).
  const switchMode = (next: ViewMode) => {
    setMode(next);
    try {
      localStorage.setItem(`agenthub-mode:${conversationKey(conversation)}`, next);
    } catch {
      // localStorage unavailable (private mode etc.) — mode still works for
      // this mount, just won't be remembered.
    }
  };

  const send = async () => {
    const message = input.trim();
    if (!message || busy || switching || !conversation.sessionId) return;
    setError('');
    setInput('');
    streamingMsg.current = null;
    setLive((prev) => [...prev, { role: 'user', text: message }]);
    setSending(true);
    try {
      const task = await window.agentHub.continueConversation({
        agent: conversation.agent,
        cwd: conversation.cwd,
        sessionId: conversation.sessionId,
        message,
      });
      currentTaskId.current = task.id;
      setTaskStatus(task.status);
    } catch (err) {
      setError(String(err));
      setSending(false);
    }
  };

  const switchToCodex = async () => {
    if (busy || switching || !conversation.path || !conversation.sessionId) return;
    setSwitching(true);
    setError('');
    try {
      const result = await window.agentHub.switchToCodex({
        sessionId: conversation.sessionId, path: conversation.path, cwd: conversation.cwd,
        instruction: handoffInstruction,
      });
      onSwitchToCodex(result);
    } catch (err) {
      setError(String(err));
      setSwitching(false);
    }
  };

  const switchToClaude = async () => {
    if (busy || switching || !conversation.path || !conversation.sessionId) return;
    setSwitching(true);
    setError('');
    try {
      const result = await window.agentHub.switchToClaude({
        sessionId: conversation.sessionId, path: conversation.path, cwd: conversation.cwd,
        instruction: handoffInstruction,
      });
      onSwitchToClaude(result);
    } catch (err) {
      setError(String(err));
      setSwitching(false);
    }
  };

  const allMessages = [...history, ...live];

  return (
    <div className="conv-view">
      <div className="conv-view-header">
        <span className={`agent-badge agent-${conversation.agent}`}>
          {conversation.agent === 'codex' ? 'Codex' : 'Claude'}
        </span>
        <span className="conv-view-cwd">{conversation.cwd}</span>
        {conversation.agent === 'claude' && (
          <button
            className="chip chip-small"
            disabled={busy || switching || !conversation.sessionId || !conversation.path}
            title={busy ? '等待 Claude 当前任务结束后切换' : '携带历史对话和项目记忆，新建 Codex 会话'}
            onClick={() => { setHandoffInstruction(input); setShowHandoff((v) => !v); }}
          >切到 Codex</button>
        )}
        {conversation.agent === 'codex' && (
          <button
            className="chip chip-small"
            disabled={busy || switching || !conversation.sessionId || !conversation.path}
            title={busy ? '等待 Codex 当前任务结束后切换' : '携带历史对话，新建 Claude 会话'}
            onClick={() => { setHandoffInstruction(input); setShowHandoff((v) => !v); }}
          >切到 Claude</button>
        )}
        <div className="mode-toggle">
          <button disabled={switching} className={`chip chip-small ${mode === 'chat' ? 'chip-active' : ''}`} onClick={() => switchMode('chat')}>
            💬 对话
          </button>
          <button
            className={`chip chip-small ${mode === 'terminal' ? 'chip-active' : ''}`}
            disabled={switching || (!conversation.sessionId && !!conversation.status)}
            title={busy ? '停止后台执行，在终端中接着当前会话继续' : '在终端中继续当前会话'}
            onClick={() => switchMode('terminal')}
          >
            ⌨ 终端
          </button>
        </div>
      </div>

      {handoffNotice && <div className="handoff-notice" role="status">{handoffNotice}</div>}
      {error && <div className="handoff-error" role="alert">{error}</div>}
      {showHandoff && (
        <div className="handoff-panel">
            <p>{conversation.agent === 'claude'
              ? '将历史对话、工具操作、压缩摘要和 Claude 项目记忆交给 Codex，在同一目录继续。原会话保留，应用内的 Claude 终端会关闭。'
              : '将历史对话和工具操作交给 Claude，在同一目录继续。原会话保留，应用内的 Codex 终端会关闭。'}</p>
          <textarea
            aria-label={conversation.agent === 'claude' ? '交接给 Codex 的要求' : '交接给 Claude 的要求'}
            placeholder={conversation.agent === 'claude' ? '补充给 Codex 的要求（可选，留空则接着之前的进展继续）' : '补充给 Claude 的要求（可选，留空则接着之前的进展继续）'}
            rows={2} maxLength={8000} value={handoffInstruction} disabled={switching}
            onChange={(e) => setHandoffInstruction(e.target.value)}
          />
          <div className="handoff-actions">
            <button className="chip chip-small" disabled={switching} onClick={() => setShowHandoff(false)}>取消</button>
            <button className="chip chip-small chip-active" disabled={busy || switching} onClick={conversation.agent === 'claude' ? switchToCodex : switchToClaude}>
              {switching ? '正在解析记忆并切换…' : '携带记忆切换'}
            </button>
          </div>
        </div>
      )}

      {mode === 'terminal' ? (
        <div className={`terminal-wrapper ${switching ? 'terminal-paused' : ''}`}>
          <TerminalView conversation={conversation} theme={theme} />
        </div>
      ) : (
        <>
          <div className="conv-messages">
            {loading && <p className="placeholder">加载历史对话中…</p>}
            {!loading && !allMessages.length && <p className="placeholder">还没有内容。</p>}
            {allMessages.map((m, i) => (
              <div key={i} className={`bubble-row bubble-row-${m.role}`}>
                <div className={`bubble bubble-${m.role}`}>{m.text}</div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <div className="conv-input-row">
            <textarea
              className="conv-input"
              rows={2}
              placeholder={conversation.sessionId ? '继续输入消息…' : '等待当前任务完成后才能继续对话…'}
              value={input}
              disabled={!conversation.sessionId || busy || switching}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button className="conv-send-btn" onClick={send} disabled={!canSend}>
              {sending ? '…' : '发送'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
