import { useMemo, useState } from 'react';
import type { AgentKind, ConversationSummary } from '../core/types';
import { compareConversations, matchesConversationAge } from '../shared/conversationOrder';

interface Props {
  conversations: ConversationSummary[];
  selectedKey: string | null;
  onSelect: (c: ConversationSummary) => void;
  onNew: () => void;
  /** Called after a bulk delete completes, with the keys removed, so
   * App.tsx can refresh the list and deselect anything that got deleted. */
  onDeleted: (deletedKeys: string[]) => void;
  onRenamed(): Promise<unknown>;
}

type AgentFilter = 'all' | AgentKind;
type DaysFilter = 7 | 30 | 0; // 0 = 全部时间

// Identifies a conversation across re-fetches of the `conversations` list —
// sessionId once the CLI has assigned one, else the AgentHub taskId for a
// just-created conversation that hasn't gotten a session yet. Exported so
// App.tsx can compute the same key for its `selected` conversation without
// duplicating this fallback logic.
export function conversationKey(c: ConversationSummary): string {
  return `${c.agent}:${c.sessionId || c.taskId}`;
}

// All filtering here is client-side over the already-fetched `conversations`
// prop (bounded to a couple hundred rows — see inspector.ts's history scan
// limit) rather than round-tripping through IPC per filter change.
export default function ConversationSidebar({ conversations, selectedKey, onSelect, onNew, onDeleted, onRenamed }: Props) {
  const [agentFilter, setAgentFilter] = useState<AgentFilter>('all');
  const [cwdFilter, setCwdFilter] = useState<string>('all');
  const [daysFilter, setDaysFilter] = useState<DaysFilter>(7);
  const [selectMode, setSelectMode] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState<{ key: string; title: string } | null>(null);
  const [savingTitle, setSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState('');
  const [pinning, setPinning] = useState<Set<string>>(new Set());

  const togglePinned = async (conversation: ConversationSummary) => {
    const key = conversationKey(conversation);
    if (pinning.has(key)) return;
    setPinning((prev) => new Set(prev).add(key));
    setTitleError('');
    try {
      await window.agentHub.setConversationPinned({
        agent: conversation.agent, sessionId: conversation.sessionId, path: conversation.path, pinned: !conversation.pinnedAt,
      });
      await onRenamed();
    } catch (error) {
      setTitleError(String(error));
    } finally {
      setPinning((prev) => { const next = new Set(prev); next.delete(key); return next; });
    }
  };

  const saveTitle = async (conversation: ConversationSummary) => {
    if (!editing || editing.key !== conversationKey(conversation) || savingTitle) return;
    setSavingTitle(true);
    setTitleError('');
    try {
      await window.agentHub.setConversationTitle({
        agent: conversation.agent, sessionId: conversation.sessionId, title: editing.title,
      });
      await onRenamed();
      setEditing(null);
    } catch (error) {
      setTitleError(String(error));
    } finally {
      setSavingTitle(false);
    }
  };

  const cwdOptions = useMemo(() => {
    const set = new Set(conversations.map((c) => c.cwd));
    return Array.from(set).sort();
  }, [conversations]);

  const filtered = useMemo(() => {
    const cutoff = daysFilter === 0 ? 0 : Date.now() - daysFilter * 24 * 60 * 60 * 1000;
    return conversations.filter((c) => {
      if (agentFilter !== 'all' && c.agent !== agentFilter) return false;
      if (cwdFilter !== 'all' && c.cwd !== cwdFilter) return false;
      // Filters by lastActivityAt (newest of: task update / file mtime /
      // creation), matching the sort order — "近7天" should read as
      // "conversations I touched in the last 7 days". It originally filtered
      // by createdAt, which hid an old conversation the user had *just*
      // resumed: sorted to the very top by recency yet filtered out of view,
      // looking like it vanished again.
      if (!matchesConversationAge(c, cutoff)) return false;
      return true;
    }).sort(compareConversations);
  }, [conversations, agentFilter, cwdFilter, daysFilter]);

  const toggleSelectMode = () => {
    setSelectMode((v) => !v);
    setChecked(new Set());
  };

  const toggleChecked = (key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const deleteSelected = async () => {
    if (!checked.size || deleting) return;
    const targets = conversations.filter((c) => checked.has(conversationKey(c)));
    if (!window.confirm(`确定删除选中的 ${targets.length} 个会话吗？这会从磁盘上真正删掉，无法撤销。`)) return;

    setDeleting(true);
    try {
      await window.agentHub.deleteConversations({
        items: targets.map((c) => ({ agent: c.agent, sessionId: c.sessionId, path: c.path })),
      });
      onDeleted(Array.from(checked));
      setChecked(new Set());
      setSelectMode(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-top-row">
        <button className="new-conv-btn" onClick={onNew}>
          ＋ 新对话
        </button>
        <button className="icon-btn select-mode-btn" onClick={toggleSelectMode}>
          {selectMode ? '取消' : '选择'}
        </button>
      </div>

      {titleError && <p className="sidebar-title-error" role="alert">{titleError}</p>}

      {selectMode && (
        <div className="bulk-delete-row">
          <span className="bulk-delete-count">已选 {checked.size} 个</span>
          <button className="icon-btn delete-selected-btn" onClick={deleteSelected} disabled={!checked.size || deleting}>
            {deleting ? '删除中…' : '删除选中'}
          </button>
        </div>
      )}

      <div className="sidebar-filters">
        <div className="filter-row">
          {(['all', 'codex', 'claude'] as AgentFilter[]).map((a) => (
            <button
              key={a}
              className={`chip chip-small ${agentFilter === a ? 'chip-active' : ''}`}
              onClick={() => setAgentFilter(a)}
            >
              {a === 'all' ? '全部' : a === 'codex' ? 'Codex' : 'Claude'}
            </button>
          ))}
        </div>
        <div className="filter-row">
          {([7, 30, 0] as DaysFilter[]).map((d) => (
            <button
              key={d}
              className={`chip chip-small ${daysFilter === d ? 'chip-active' : ''}`}
              onClick={() => setDaysFilter(d)}
            >
              {d === 0 ? '全部时间' : `近${d}天`}
            </button>
          ))}
        </div>
        <select className="filter-select" value={cwdFilter} onChange={(e) => setCwdFilter(e.target.value)}>
          <option value="all">全部目录</option>
          {cwdOptions.map((cwd) => (
            <option key={cwd} value={cwd}>
              {cwd}
            </option>
          ))}
        </select>
      </div>

      <ul className="conv-list">
        {filtered.map((c) => {
          const key = conversationKey(c);
          const title = c.title ?? c.cwd.split('/').filter(Boolean).pop() ?? c.cwd;
          return (
            <li
              key={key}
              className={`conv-item ${selectedKey === key ? 'conv-item-active' : ''}`}
              onClick={() => (selectMode ? toggleChecked(key) : onSelect(c))}
            >
              <div className="conv-item-top">
                {selectMode && (
                  <input
                    type="checkbox"
                    checked={checked.has(key)}
                    onChange={() => toggleChecked(key)}
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
                <span className={`agent-dot agent-dot-${c.agent}`} />
                {editing?.key === key ? (
                  <form className="conv-title-form" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); saveTitle(c); }}>
                    <input
                      autoFocus aria-label="会话标题" maxLength={500} value={editing.title} disabled={savingTitle}
                      placeholder="留空恢复原标题"
                      onChange={(e) => setEditing({ key, title: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape' && !savingTitle) { setEditing(null); setTitleError(''); }
                      }}
                    />
                    <button type="submit" className="conv-title-action" title="保存标题" aria-label="保存标题" disabled={savingTitle}>✓</button>
                    <button type="button" className="conv-title-action" title="取消编辑" aria-label="取消编辑" disabled={savingTitle} onClick={() => { setEditing(null); setTitleError(''); }}>×</button>
                  </form>
                ) : (
                  <>
                    <span className="conv-item-title" title={c.fullTitle ?? title}>{title}</span>
                    {!selectMode && c.sessionId && (
                      <button
                        className={`conv-title-action conv-pin-action ${c.pinnedAt ? 'conv-pin-active' : ''}`}
                        title={c.pinnedAt ? '取消置顶' : '置顶会话'} aria-label={c.pinnedAt ? '取消置顶' : '置顶会话'}
                        aria-pressed={!!c.pinnedAt} disabled={pinning.has(key)}
                        onClick={(e) => { e.stopPropagation(); togglePinned(c); }}
                      >{c.pinnedAt ? '📌' : '⇧'}</button>
                    )}
                    {!selectMode && c.sessionId && (
                      <button
                        className="conv-title-action conv-title-edit" title="编辑标题" aria-label={`编辑标题：${title}`}
                        disabled={savingTitle}
                        onClick={(e) => { e.stopPropagation(); setTitleError(''); setEditing({ key, title }); }}
                      >✎</button>
                    )}
                  </>
                )}
                {!!c.mergedCount && c.mergedCount > 1 && (
                  <span className="merged-count-badge" title={`折叠了 ${c.mergedCount} 个短时间内标题相同的会话`}>
                    ×{c.mergedCount}
                  </span>
                )}
                {c.status === 'needs_attention' && (
                  <span className="attention-dot" title="可能需要你处理 — 有工具调用被拒绝或出错" />
                )}
                {c.status === 'running' && <span className="running-dot" title="运行中" />}
              </div>
              <div className="conv-item-meta">
                {relativeTime(c.lastActivityAt)} · {c.cwd}
              </div>
            </li>
          );
        })}
        {!filtered.length && (
          <p className="placeholder">{conversations.length ? '没有符合筛选条件的会话。' : '还没有会话记录。'}</p>
        )}
      </ul>
    </div>
  );
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString();
}
