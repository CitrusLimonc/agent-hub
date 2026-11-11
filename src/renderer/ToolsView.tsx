import { useEffect, useState } from 'react';
import type { AgentKind, SkillInfo } from '../core/types';

type Category = 'status' | 'settings' | 'skills' | 'apiConfig';

const CATEGORIES: { key: Category; label: string }[] = [
  { key: 'status', label: '状态' },
  { key: 'settings', label: '设置' },
  { key: 'skills', label: 'Skills' },
  { key: 'apiConfig', label: 'API 配置' },
];

// Secondary view (toggled by the header's "⚙ 工具" button) for read-only
// per-agent introspection — status/settings/skills. History used to live
// here too before it became the primary conversation sidebar in App.tsx.
export default function ToolsView() {
  const [agent, setAgent] = useState<AgentKind>('codex');
  const [category, setCategory] = useState<Category>('status');
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setText(null);
    setSkills(null);

    const load = async () => {
      if (category === 'status') {
        const r = await window.agentHub.getToolsStatus(agent);
        if (!cancelled) setText(r);
      } else if (category === 'settings') {
        const r = await window.agentHub.getToolsSettings(agent);
        if (!cancelled) setText(r);
      } else if (category === 'skills') {
        const r = await window.agentHub.getToolsSkills(agent);
        if (!cancelled) setSkills(r);
      }
      // apiConfig has its own form state — see ApiConfigPanel below, it
      // fetches getProviderConfig itself rather than sharing text/skills.
    };

    load().finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [agent, category]);

  return (
    <div className="tools-view">
      <div className="tools-agent-row">
        <button className={`chip ${agent === 'codex' ? 'chip-active' : ''}`} onClick={() => setAgent('codex')}>
          Codex
        </button>
        <button className={`chip ${agent === 'claude' ? 'chip-active' : ''}`} onClick={() => setAgent('claude')}>
          Claude Code
        </button>
      </div>
      <div className="tools-category-row">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            className={`chip chip-small ${category === c.key ? 'chip-active' : ''}`}
            onClick={() => setCategory(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="tools-content">
        {category === 'apiConfig' ? (
          <ApiConfigPanel agent={agent} />
        ) : (
          <>
            {loading && <p className="placeholder">加载中…</p>}
            {!loading && text !== null && <pre className="log-view">{text}</pre>}
            {!loading && skills !== null && <SkillList skills={skills} />}
          </>
        )}
      </div>
    </div>
  );
}

function SkillList({ skills }: { skills: SkillInfo[] }) {
  if (!skills.length) return <p className="placeholder">没有找到 skills。</p>;
  return (
    <ul className="tools-list">
      {skills.map((s) => (
        <li key={s.path} className="tools-list-item">
          <div className="tools-list-title">{s.name}</div>
          {s.description && <div className="tools-list-desc">{s.description}</div>}
        </li>
      ))}
    </ul>
  );
}

// Edits the *global* ~/.codex or ~/.claude config, not an AgentHub-only
// override — saving here changes what `codex`/`claude` do when run directly
// in a terminal too (see agentConfig.ts). Keeps its own form state separate
// from ToolsView's text/skills state since this is a two-way form, not a
// read-only viewer. The API key input is never pre-filled with the real
// value — `hasApiKey` only drives the placeholder text, and leaving the
// field blank on save means "don't change this".
function ApiConfigPanel({ agent }: { agent: AgentKind }) {
  const [loading, setLoading] = useState(true);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);

  const load = async () => {
    setLoading(true);
    try {
      const cfg = await window.agentHub.getProviderConfig(agent);
      setBaseUrl(cfg.baseUrl ?? '');
      setHasApiKey(cfg.hasApiKey);
      setApiKey('');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on agent switch only
  }, [agent]);

  const save = async () => {
    setSaving(true);
    try {
      await window.agentHub.setProviderConfig({
        agent,
        baseUrl: baseUrl.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      });
      await load();
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="placeholder">加载中…</p>;

  return (
    <div className="api-config-panel">
      <p className="api-config-hint">
        这是全局配置,会影响你在终端里直接使用 {agent === 'codex' ? 'codex' : 'claude'},不只是 AgentHub 内部。
      </p>
      <label className="api-config-field">
        <span>中转 Base URL</span>
        <input
          className="form-input"
          placeholder="例如 https://your-relay.example.com"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>
      <label className="api-config-field">
        <span>API Key</span>
        <input
          className="form-input"
          type="password"
          placeholder={hasApiKey ? '已配置,输入新值可更新' : '未配置'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      <div className="api-config-actions">
        <button className="submit-btn" type="button" disabled={saving} onClick={save}>
          {saving ? '保存中…' : '保存'}
        </button>
        {savedAt > 0 && !saving && <span className="api-config-saved">已保存</span>}
      </div>
    </div>
  );
}
