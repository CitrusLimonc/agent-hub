import { useEffect, useState, type FormEvent } from 'react';
import type { AgentKind } from '../core/types';
import type { DirTrustStatus } from '../shared/ipc';

interface Props {
  onSubmit: (agent: AgentKind, cwd: string, prompt: string) => void;
  onOpenTerminal: (agent: AgentKind, cwd: string) => void;
}

// Shown in App.tsx's conv-pane whenever nothing is selected in the sidebar —
// starts a brand-new conversation, either headless (onSubmit, needs a
// prompt) or as a real interactive terminal (onOpenTerminal — just agent +
// cwd, no prompt; you type directly into the spawned CLI instead).
export default function NewTaskForm({ onSubmit, onOpenTerminal }: Props) {
  const [agent, setAgent] = useState<AgentKind>('codex');
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [trust, setTrust] = useState<DirTrustStatus | null>(null);
  const [trusting, setTrusting] = useState(false);

  // Directory-trust check (Codex [projects."..."] / Claude ~/.claude.json):
  // headless runs can't show the CLIs' interactive trust dialog, and until
  // the directory is trusted they silently ignore the directory's own
  // permission whitelist ("Ignoring N permissions.allow entries …"). Query
  // on every cwd change so the trust row below always reflects the input.
  useEffect(() => {
    let cancelled = false;
    const dir = cwd.trim();
    if (!dir) {
      setTrust(null);
      return;
    }
    window.agentHub.getDirTrust(dir).then((status) => {
      if (!cancelled) setTrust(status);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const trustDirectory = async () => {
    const dir = cwd.trim();
    if (!dir || trusting) return;
    setTrusting(true);
    try {
      setTrust(await window.agentHub.trustDir(dir));
    } finally {
      setTrusting(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!cwd.trim() || !prompt.trim()) return;
    onSubmit(agent, cwd.trim(), prompt.trim());
    setPrompt('');
  };

  const pickDirectory = async () => {
    const picked = await window.agentHub.pickDirectory();
    if (picked) setCwd(picked);
  };

  return (
    <form className="new-task-form" onSubmit={submit}>
      <div className="form-row">
        <label>
          <input type="radio" checked={agent === 'codex'} onChange={() => setAgent('codex')} /> Codex(失败自动切 Claude)
        </label>
        <label>
          <input type="radio" checked={agent === 'claude'} onChange={() => setAgent('claude')} /> Claude Code
        </label>
      </div>
      <div className="form-row">
        <input
          className="form-input form-input-grow"
          placeholder="工作目录,例如 /Users/you/repo"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
        />
        <button type="button" className="pick-dir-btn" onClick={pickDirectory}>
          选择目录…
        </button>
      </div>
      {trust && !(trust.codex && trust.claude) && (
        <div className="trust-row">
          <span className="trust-hint">
            ⚠ 目录未被信任（{trust.codex ? 'Codex ✓' : 'Codex ✗'} · {trust.claude ? 'Claude ✓' : 'Claude ✗'}），目录内的权限白名单会被忽略
          </span>
          <button type="button" className="pick-dir-btn" onClick={trustDirectory} disabled={trusting}>
            {trusting ? '信任中…' : '信任此目录'}
          </button>
        </div>
      )}
      <textarea
        className="form-textarea"
        placeholder="任务描述"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
      />
      <div className="form-row form-actions-row">
        <button
          type="button"
          className="pick-dir-btn"
          disabled={!cwd.trim()}
          onClick={() => cwd.trim() && onOpenTerminal(agent, cwd.trim())}
        >
          ⌨ 在终端中打开
        </button>
        <button className="submit-btn" type="submit">
          启动
        </button>
      </div>
    </form>
  );
}
