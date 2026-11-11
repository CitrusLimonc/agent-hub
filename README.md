# AgentHub

Mac 菜单栏工具，统一管理 Codex CLI 和 Claude Code CLI 在本机上的所有任务和会话。

## 功能

### 统一会话列表

左侧时间线混合展示 Codex 和 Claude 的全部历史会话（包括外部终端启动的），按最近活动排序，支持按 Agent、目录、时间范围筛选和批量删除。

### 双模式查看与续聊

- **对话模式**：还原完整历史记录，继续输入消息（headless 子进程）
- **终端模式**：node-pty + xterm.js 跑 `codex resume` / `claude --resume`，和 Terminal.app 完全一致，能边跑边输入
- 每个会话记住上次使用的模式，下次自动恢复

### 会话置顶

悬停侧栏条目，点击 ⇧ 置顶（已置顶显示 📌）。置顶会话始终排在最前面，不受时间和扫描上限影响，重启仍生效。

### 编辑会话标题

悬停条目点击铅笔图标编辑，支持自定义标题（持久化到 SQLite，CLI 自动标题不会覆盖）。

### 跨 Agent 切换

支持双向手动切换（均可携带历史记忆）：

- **Claude → Codex**：解析会话分支的用户/助手消息、工具输入和结果、压缩摘要、项目记忆文件，生成交接快照后在同一目录启动 Codex
- **Codex → Claude**：解析 rollout 中的用户/助手消息和工具调用，生成交接快照后在同一目录启动 Claude

自动故障转移：Codex 任务失败时自动构建交接说明交给 Claude 在同一目录继续。

### 全局 API 配置

工具面板中配置两边的中转 Base URL 和 API Key（写入各自 CLI 的全局配置文件，终端里直接用也生效）。

### 其他

- 亮/暗主题（终端跟随切换）
- 目录信任提示 + 一键信任
- 新建对话时自动检测两边目录信任状态

## 安装与使用

### 下载

从 [Releases](https://github.com/CitrusLimonc/agent-hub/releases) 下载最新的 `.dmg` 文件，打开后拖入 Applications。

### 前置要求

- macOS（Apple Silicon）
- 本机已安装 [Codex CLI](https://github.com/openai/codex) 和 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

### 使用

点击菜单栏图标打开面板。点击「+ 新对话」填写目录和任务描述，或从列表中选择已有会话继续。首次在未信任目录中新建对话时会提示信任。

### 开发构建

```bash
npm install   # 需要 Node ≥ 18（推荐 22）
npm run dev   # 开发模式
npm run dist:mac  # 打包 DMG
```

## 技术栈

- Electron + TypeScript，菜单栏 Tray API，无 Dock 图标
- React + xterm.js
- better-sqlite3（本地持久化，postinstall 自动 electron-rebuild）
- CLI 子进程通过 `--json` / `stream-json` 事件流监控

## 已知限制

- 跨 Agent 切换重建的是对话历史和工具操作记录，不迁移模型内部状态（两种 API 协议不互通，字节级无缝续接物理上不可能）
- PTY 终端 buffer 200KB 截断上限，超出部分历史不可回放（底层 session 文件完整）
- 历史扫描上限 200 条
- 终端模式不触发自动故障转移（设计取舍）
- Codex 工具调用还原为 best-effort

## License

MIT
