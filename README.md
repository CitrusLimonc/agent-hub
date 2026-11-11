# AgentHub

Mac 菜单栏工具,统一管理 Codex CLI 和 Claude Code CLI 在本机上的任务。主界面是左侧统一时间线(混合展示两边全部历史会话,不管是不是 AgentHub 启动的,支持按 agent/目录/最近活动时间筛选,默认近 7 天,支持批量删除),点开任意一条还原完整历史对话,可以继续输入消息接着聊,也可以一键切到**内嵌真实终端**(node-pty + xterm.js 跑 `codex resume`/`claude --resume` 的真实交互式进程)——和直接在 Terminal.app 里操作完全一致,能边跑边输入;每个会话会记住你上次是用"对话"还是"终端"模式打开的,下次点开直接回到那个模式。另外 Codex 因 API 通道故障失败时会自动把任务交接给 Claude Code 在同一目录继续跑。窗口可拖动、可缩放,支持亮/暗主题切换(内嵌终端也跟着切)。"工具" 面板里还能直接配置两边的中转 Base URL 和 API Key,改的是**全局配置**,在终端里直接用 `codex`/`claude` 也生效。

## 置顶会话与终端接管

悬停侧栏会话，点击 ⇧ 置顶；已置顶会话显示 📌，再次点击可取消。置顶会话始终排在普通会话前，多个置顶按置顶时间倒序排列。置顶保存在本地数据库中，重启仍生效，不受“近 7 天 / 近 30 天”限制，也不受常规 200 条历史扫描上限影响；agent 和目录筛选仍然生效。取消置顶后恢复按最近活动时间排列。

后台运行中或“需要处理”的会话也可以点击 **终端**：AgentHub 会先停止该后台进程，等待退出，再以原会话 ID 启动交互式终端。手动接管不会触发 Codex 失败转 Claude 的自动交接；准备过程和错误信息会显示在终端中。

## 编辑会话标题

悬停侧栏会话时，点击标题旁的铅笔图标编辑，按 Enter 或点击 ✓ 保存，按 Esc 或点击 × 取消；留空保存可恢复原始标题。自定义标题保存在 AgentHub 的 SQLite 数据库中，重启仍然生效，后续 CLI 自动生成标题不会覆盖它。标题较长时侧栏显示省略号，悬停标题可通过系统气泡查看完整标题。

## 手动将 Claude 会话切到 Codex

打开任意 Claude 历史会话，点击顶部 **切到 Codex**，可补充下一步要求，再点击 **携带记忆切换**。Codex 会在同一工作目录中新建会话并继续，原 Claude 会话保留；聊天模式和终端模式均可发起切换。正在运行的对话任务需先结束；应用内的 Claude 终端会在生成交接快照前关闭。应用外的 Claude 进程请先停止，AgentHub 无法监控它们。

交接会解析当前会话分支的用户消息、Claude 回复、完整工具输入和结果、压缩摘要，以及会话项目目录下 `memory/**/*.md` 自动记忆文件。压缩边界通过 `logicalParentUuid` 追溯此前历史，回退后弃用的分支及后台子会话不混入。仓库内的 `CLAUDE.md` 由 Codex 按需读取；图片/PDF 等二进制附件只保留类型和已有路径，不转换成文本，也不迁移模型内部状态。

完整交接文件保存到 AgentHub 用户数据目录的 `handoffs/<id>.md`（macOS 通常为 `~/Library/Application Support/agent-hub/handoffs/`，目录权限 700、文件权限 600），不会往项目仓库写文件。新会话的首条消息包含文件路径、原始目标和最近进展摘录，长历史从文件分段读取，避免把数 MB 记录塞进启动参数。快照会保留以供重启后追溯，删除原会话不会自动删除它。无法解析的 JSON 行会显示跳过数量；空会话或读文件失败会明确报错。

## 现实边界(重要,先读)

Codex(OpenAI Responses API + shell/apply_patch 工具)和 Claude Code(Anthropic Messages API + Bash/Edit/Read 工具)底层协议和工具 schema 完全不互通,**字节级无缝续接模型内部状态在物理上不可能**。

本工具做的是:失败时读取 Codex 已经执行过的操作(命令、文件改动、最后的进展描述),重建一段任务交接说明,在同一工作目录下拉起 Claude Code 继续——工作目录里的文件改动是真实、连续的,只有"模型的思考过程"部分是重建而非精确恢复。

## 技术选型

- Electron + TypeScript,菜单栏用 `Tray` API,无 Dock 图标
- 渲染进程用轻量 React
- 本地持久化用 `better-sqlite3`(原生模块,针对 Electron 的 ABI 编译——`npm install` 会自动跑 `postinstall: electron-rebuild`,不要用普通 `npm rebuild`)
- 两个 CLI 都通过自己 spawn 子进程 + 消费其 `--json`/`stream-json` 结构化事件流来监控；历史展示和手动交接会解析本地 session 文件
- App 退出时(`before-quit`)会 kill 掉所有还在跑的 codex/claude 子进程——它们不是 `detached` 的,但 Node 不会在父进程退出时自动杀子进程,不处理的话会变成后台孤儿进程继续跑、继续计费
- 亮/暗主题:颜色全走 CSS 变量(`src/renderer/styles.css` 里 `:root` 定义暗色默认值,`[data-theme='light']` 覆盖),右上角按钮切换,记在 `localStorage`,首次打开跟随系统 `prefers-color-scheme`
- **内嵌终端**(`src/core/ptyManager.ts` + `src/renderer/TerminalView.tsx`):`node-pty` 在主进程里跑 CLI 的真实交互式进程(`codex resume <id>` / `claude --resume <id>`,新对话则是不带参数的 `codex`/`claude`),`@xterm/xterm` 在渲染进程渲染,IPC 桥接方式跟 `pickDirectory`/`hidePanel` 一样走 `contextBridge`。PTY 会话完全不进 taskStore——它是开放式的交互进程,没有"完成"状态,硬塞进一次性任务模型会把"运行中"状态搞乱。关掉终端视图不杀进程,只是不再显示,进程留在主进程里继续跑;主进程同时缓存一份有上限(200KB)的输出 buffer,切回来时先回放再接实时输出
- **API 配置**(`src/core/agentConfig.ts`):在"工具"面板里直接编辑 Codex/Claude 的全局配置,不是 AgentHub 自己的独立覆盖层。Codex 侧对 `~/.codex/config.toml` 做"外科手术式"文本替换,只动顶层 `model_provider` 这一行和一个专属的 `[model_providers.agenthub]` 区块,不解析、不重写文件其余部分(用户自己那几十条 `[projects."..."]` 信任记录和其它 provider 定义原样保留)。API key 不写进 config.toml——走官方的 `codex login --with-api-key`,key 通过子进程 stdin 传入,不出现在 argv/`ps` 里。Claude 侧直接读写 `~/.claude/settings.json` 的 `env` 字段(`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`),JSON parse/merge/stringify,保留 `theme`/`model` 等其它已有字段。面板上 API Key 输入框永远不回显真实值,只用一个 `hasApiKey` 布尔值驱动 placeholder 文案

## 权限策略(Security tradeoffs)

- **Codex**:用 `-s workspace-write` 沙箱,允许在工作目录内自动执行 shell 命令,不弹审批
- **Claude Code**:用 `--permission-mode acceptEdits`,自动放行文件编辑(Write/Edit),但 **Bash 命令仍需审批**。因为是 headless `-p` 模式没有 TTY 应答审批,所以 Claude Code 侧如果任务需要跑 shell 命令,会在审批循环里反复重试直到放弃(浪费 tokens),不会挂起。这是刻意选择的更安全但功能更窄的选项,而不是 `--dangerously-skip-permissions`(全部跳过审批)——如果想要 Claude Code 也能自动跑 shell 命令,去改 `src/core/claudeAdapter.ts` 里的 `CLAUDE_BASE_ARGS`,但要清楚这意味着无人值守时任意 shell 命令都会自动执行

## 开发

```bash
# 使用 Node.js 20 或更新版本
npm install
npm run dev      # 启动 vite + tsc watch + electron
npm run typecheck
npm test         # 会话记忆解析、交接与子进程启动测试（使用替身 CLI，不调用模型）
npm run build
# 可选：构建后运行隐藏窗口交互验证（终端按钮、xterm、置顶/取消置顶）
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron tests/ui.electron.cjs
npm run dist:mac # 打包 arm64 dmg 到 release/
```

App 图标在 `build/icon.icns`(深色圆角底机器人,左眼绿=Codex、右眼橘=Claude,呼应菜单栏的 🤖)。源文件是 `/tmp` 下的手写 SVG 经 QuickLook 渲染 + `iconutil` 打包生成的;想换图标:替换 `build/icon.icns` 重新 `dist:mac` 即可(electron-builder 也认 `build/icon.png`,≥512x512)

已验证(2026-09-03,真实 spawn 真实 CLI,非 mock):
- Codex/Claude Code 任务正常跑完,拿到 `succeeded` 状态
- Codex spawn 失败 → 自动生成交接 brief → 自动拉起 Claude Code → 两个任务在 sqlite 里正确通过 `handoffFromTaskId`/`handoffToTaskId` 关联
- 面板"工具"入口:Codex/Claude 各自的状态(`codex doctor --json` / `claude auth status`)、配置文件原文、skills 列表(含 symlink 安装的),都读到真实数据
- **统一会话侧栏 + 续聊**:`codex exec resume <id> "<msg>"` / `claude -p --resume <id> "<msg>"` 连续跑两轮,session 正确延续,`getCodexTranscript`/`getClaudeTranscript` 整份解析磁盘文件还原出的历史气泡顺序和内容跟原始 session 完全对得上(用这次开发过程本身的真实 Claude session 验证过,连 WebSearch 调用都精确还原)
- 原生目录选择器:`dialog.showOpenDialog` 弹出系统 Finder 选择器,选中路径正确回填
- **实时流式输出**:Claude 侧加了 `--include-partial-messages`,实测能拿到逐 token 的 `stream_event`,聊天气泡跟着一个字一个字更新,不再是等模型说完一整段才展示;Codex/Claude 的工具调用结果(不只是"调用了什么工具")现在也展示出来了;Codex 的命令执行会先显示"⏳ 进行中"再显示完成结果
- **批量删除历史会话**:`codex delete <id> --force` / 直接 `fs.unlink` claude 的 session 文件,真删磁盘,同时清理 taskStore 里关联的 task 记录,实测过文件确实消失、历史列表里也不再出现
- **内嵌终端**:选一个真实历史会话切到"终端"模式,里面显示的确实是 `codex resume`/`claude --resume` 的完整交互式界面(model/directory 卡片、之前的对话历史、更新提示……跟直接在 Terminal.app 里跑一模一样);实测过键盘输入能正确回传给 pty(输入 `3` 回车能翻过更新提示,后面接着显示原会话历史);应用退出后用 `ps aux` 确认交互式子进程被清理,没有孤儿进程残留
- **API 配置**:在一份复制出来的真实 `~/.codex/config.toml`(3 个 provider + 约 30 条 `[projects."..."]` 信任记录)上测试写入,`diff` 确认只有顶层 `model_provider` 一行改了、文件末尾多了一个 `[model_providers.agenthub]` 区块,其余全部字节不变;二次保存验证区块是原地替换而不是重复追加;stdin 传参机制单独用 `cat` 替身命令验证过管道读写正确,没有实际调用 `codex login` 动用户真实账号;Claude 侧 `settings.json` 的 get/set 用同样的复制文件测试过 relay+key 写入、仅更新 key、清空 baseUrl 三种场景,`theme`/`model` 字段全程未受影响;真实跑起来的面板上,Codex 分类页正确读出了用户当前生效的中转地址,API Key 栏只显示"已配置/未配置",没有明文泄露

## 核心实现说明

`src/core/inspector.ts` 是"工具"和"历史会话还原"的核心,踩过几个坑,记录一下防止以后又踩:
- Skills 目录里的子目录经常是 symlink(比如从共享 skill 仓库装进来的),`Dirent.isDirectory()` 对 symlink 返回 `false`——不能用它来过滤,直接尝试读 `SKILL.md`,失败就跳过。`~/.claude/projects/` 下的项目目录同理
- Codex 的 session 文件第一行(`session_meta`)会内嵌很长的 skills 说明文本,常规几十 KB 的头部读取都不够——历史摘要(标题/cwd/时间)用有界的头部分片读取(256KB)+ 逐行 `JSON.parse`(最后一行可能被截断,直接被 catch 跳过,不用手写正则判断完整性);**完整历史对话还原**(`getCodexTranscript`/`getClaudeTranscript`)则是整份读文件解析,session 文件见过到 10MB 的,没做分页
- `codex doctor --json` 在 `overallStatus` 为 `warning`/`error` 时会以非零退出码退出,即便 stdout 里是完整有效的 JSON——`execFile` 的 promise 会 reject,要在 catch 分支里从 `err.stdout` 里把这段 JSON 捞出来,不能当成真失败
- `codex exec resume` 和 `codex exec` 的可用参数不一样——`resume` 不接受 `-s`/`--cd`(沙箱模式和工作目录继承自被恢复的原始 session),硬传会直接报参数错误
- 两边 CLI 都是一次性进程,没有"给还在跑的进程发新消息"这种交互——每一轮对话都是重新 spawn 一次 `resume`,UI 层必须等上一轮真正到达终态(`succeeded`/`failed`)才能解锁输入框,否则会话文件可能被并发访问出问题(已验证:提前发送会导致 resume 失败或静默无效)
- Claude Code 会给自己派发后台子任务(Task 工具的后台路由),这些 session 文件的第一条用户消息带 `"sessionKind":"bg"`,标题和 cwd 跟派发它的主会话一样,在历史列表里会显得像重复项——`getClaudeHistory` 已经过滤掉这类,正常主会话没有这个字段
- **Codex 侧栏"重复标题"是另一回事**(`collapseBursts`,`inspector.ts`):Codex 的 session 数据里完全没有"这是子任务/自动化任务"这种标记字段,实测发现真正的原因是这台机器上跑的其它自动化系统(比如这个 orchestrator 项目自己的定时健康检查、竞品追踪任务)也会调用同一个 `codex` CLI,写进同一个 `~/.codex/sessions/`——这些 session 标题固定、cwd 固定、几分钟内扎堆出现,和 AgentHub 无关但混在一起看着像重复的子进程。现在 `getCodexHistory` 会把同一个 `(cwd, 标题)` 在 10 分钟窗口内扎堆出现的 session 折叠成一条,标题后面显示 `×N` 提示折叠了几条,鼠标悬停能看到详情;隔了几小时/几天的同标题重复(比如手动测试打了两次"hi")不在折叠窗口内,原样保留。**踩了一个坑**:`codex resume` 每续聊一轮都会新建一个 rollout 文件,但 `session_meta.payload.session_id` 全程不变、标题也不变(Codex 0.162 起优先读 state 库 `threads.name`,也就是 `/status` 展示的 AI Thread name;没有 name 时才退回第一条用户消息)——如果不先按 `id` 去重就直接按标题分组折叠,会把同一个真实多轮对话的好几个文件误判成"自动化扎堆",而且当时用 `.id` 字符串当 `Set`/`Map` 的 key 还有个更隐蔽的 bug:好几行数据共享同一个 `id` 值时,过滤和计数都会全部命中,导致同一条对话在结果里出现好几次、`×N` 数字还都一样。修复方式是先按 `id` 去重(保留最早一轮,跟 `createdAt` 语义一致),折叠逻辑再用对象引用(而不是 `.id` 值)做 `Set`/`Map` 的 key,才能正确处理"同一个 id 出现好几行"这种情况
- `codex delete` 非交互执行必须带 `--force`,不带的话会报"cannot confirm session deletion without an interactive terminal"直接退出(已实测)
- Claude 的 `stream_event` 增量(`content_block_delta`)不会写进磁盘 session 文件,只在 `--include-partial-messages` 的实时输出里出现——所以只有 `ConversationView.tsx` 的实时渲染路径需要特殊处理,`getClaudeTranscript` 读历史完全不受影响
- `electron-rebuild` 一次指定多个原生模块要用逗号分隔单个 `-w`(`-w better-sqlite3,node-pty`),不能重复写 `-w` 参数——重复写会直接在 CLI 参数解析阶段报 `argv.w.split is not a function` 崩掉
- xterm.js 的 `theme.background: 'transparent'` + `allowTransparency: true` 组合在这个版本里实测不生效(渲染出来还是不透明黑色),改用和 CSS 变量对应的实色背景更可靠;另外 xterm.css 自带的 `.xterm-viewport{background-color:#000}` 也要用更高优先级选择器覆盖掉,不然缩放时边缘会露黑
- **打包后终端一点就"[进程已退出,退出码 1]"**(`electron/fixPath.ts`):`npm run dev` 是从终端起的 Electron,继承了终端 shell 的完整 PATH(nvm 把 `codex`/`claude` 所在的 bin 目录加进去了);但打包后的 `.app` 从 Finder/Dock 启动,拿到的是系统给的最小 PATH(`/usr/bin:/bin:/usr/sbin:/sbin`),压根不知道 nvm 装的东西在哪,所有 spawn 瞬间失败。更坑的是连"读取用户登录 shell 的真实 PATH"这个常规做法都不够用——`nvm alias default` 指向的版本不一定同时装了这两个 CLI(实测这台机器默认是 v16,只有 `codex` 没有 `claude`)。最终方案是启动时扫描 `~/.nvm/versions/node/*` 下每个版本,**实际跑一次 `--version`**(而不是只看文件存不存在)挑出真正两个都能正常工作的版本目录塞到 PATH 最前面——光看文件存在还不够,这台机器上最新版本(v22)的 `codex` 装了但一运行就被 SIGKILL(和 AgentHub 无关,是那个全局安装本身坏了)。另外 `codex`/`claude` 本身是 `#!/usr/bin/env node` 脚本,就算用绝对路径调用,系统处理 shebang 时还是会再查一次 PATH 找 `node`,所以探测某个候选版本时必须先把它自己的 bin 目录临时塞进 PATH,不然连自己配的 node 都找不到,会把"根本没测出来"误判成"这个版本坏了"
- **打包后内嵌终端里 Claude 提示"Not logged in",回复内容也和本机终端不一样**(同样是 `electron/fixPath.ts`):根因和上面 PATH 的问题是一类——这台机器上 Claude Code 的登录状态**不是**存在 OAuth 凭证文件或系统钥匙串里(实测过,钥匙串里唯一相关的条目是 Claude 桌面客户端的 `Claude Safe Storage`,和 Claude Code CLI 无关;`~/.claude/` 目录下也没有任何凭证文件),而是完全靠 `.zshrc` 里手动 `export` 的 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`(指向一个第三方中转,不是官方 API)。这些变量只在交互式 shell 里生效,Finder 启动的打包 App 完全看不到——所以内嵌终端里的 `claude` 进程压根没有任何鉴权信息,直接报"Not logged in";就算某些情况下摸到了别的兜底鉴权,走的也可能是完全不同的后端,回复内容自然对不上本机终端。修复方式是把原来只读 PATH 的登录 shell探测,改成用 `env -0` 一次性拿到登录 shell 的**完整环境变量**(不只是 PATH),除 PATH 外全部原样合并进主进程(shell 里配置的值优先,因为那才是用户真正想要的配置),PATH 那部分继续走上面 nvm 版本探测的逻辑,两者互不冲突
- **打开 App 时弹"未打开'codex',因其包含恶意软件"**:排查下来跟 AgentHub 本身没关系——用 `spctl -a -vv` 查这台机器上某个 nvm 版本装的 `codex` 底层原生二进制,报的是 `CSSMERR_TP_CERT_REVOKED`(签名证书被吊销了,不是文件损坏),Mac 对签名证书被吊销的二进制会直接拦截+弹这个系统级警告。问题是 `fixPath.ts` 启动时会扫描每个 nvm 版本、**真的执行一次** `--version` 来判断哪个版本可用(见上面 PATH 那条),扫到这个被吊销证书的版本时,哪怕我们代码里 catch 住了报错,Mac 系统层面该拦的还是会拦、该弹的弹窗还是会弹——所以每次开 App 都会重新触发一次。修复成给探测结果加了本地缓存(`~/Library/Application Support/agent-hub/verified-cli-bin.json`,按 `codex`/`claude` 文件的 mtime 判断缓存是否还有效),扫到一个可用版本后记下来,以后启动直接读缓存、不再重新探测——也就是说这个警告最多再出现一次(缓存生效前的最后一次冷启动),之后除非重装/升级了 codex/claude 才会重新触发探测
- **退出 App 时报 `Uncaught Exception: TypeError: Object has been destroyed`**(`electron/main.ts`):`panel?.webContents.send(...)` 这个写法只防得住 `panel` 是 `null` 的情况,防不住 `panel` 变量还在但底层原生窗口对象已经被销毁——退出时 `before-quit` 会 kill 掉所有 pty/task 进程,这些进程的退出/输出回调经常会在 panel 窗口自己的销毁流程之后(或与之竞态)才触发,这时候再调 `webContents.send` 就会抛出这个异常。改成统一过一个 `sendToPanel()` 小函数,发送前额外判一次 `!panel.isDestroyed()`,已经销毁就直接跳过发送(反正也没人能收到了)
- **"在终端中打开"新会话后切走就再也找不到**(三个问题叠加,`App.tsx` + `ptyManager.ts`):① 乐观会话只存在于 `selected` 状态里,从没进侧边栏列表,而列表唯一的刷新触发是 headless 任务的 onStatus 事件——pty 会话永远不触发,磁盘上已生成的新会话文件永远扫不进来;② 原来那个 pty 进程的 key(乐观随机 taskId)导航离开后从 UI 上永久不可达,变成孤儿进程一直跑到退出,而且之后从侧边栏打开真实会话的终端模式会对同一个 session 文件起第二个交互进程;③ 最隐蔽的:如果 AgentHub 本身是在某个 claude 会话里启动的(比如 dev 模式),`process.env` 里带着父会话的 `CLAUDE_CODE_SESSION_ID`/`CLAUDE_CODE_CHILD_SESSION`,ptyManager 原样透传给子 claude 后,它会认为自己是个"子会话",**静默不写自己的会话文件**——对话正常进行但磁盘上什么都不留,自然怎么刷都扫不到(实测:剥掉这几个变量后 jsonl 立刻正常落盘)。修复:导航(点选会话/+新对话/再开新终端)时刷新会话列表 + 打开新终端 3 秒后补刷一次;导航离开乐观终端会话时显式 kill 掉对应 pty(`pty:kill` 新 IPC 通道;同会话内切"对话/终端"模式不走 App,保持原来的保活行为);`ptyManager`/`processRunner` 起 CLI 前统一剥掉 `CLAUDE_CODE_SESSION_ID`/`CLAUDE_CODE_CHILD_SESSION`/`CLAUDE_CODE_ENTRYPOINT`/`CLAUDE_CODE_EXECPATH` 这几个身份变量
- **最近活动排序 + "近N天"按最近活动筛选**(`inspector.ts` 的 `lastModifiedAt` + `main.ts` + `ConversationSidebar.tsx`):原来排序依据是"task 记录的更新时间,否则 session 创建时间"——AgentHub 里 headless 续聊的会话会浮上来,但**在外部终端 resume 的、或在内嵌终端里操作的旧会话**没有任何 task 记录,排序还停在创建时间,7 天前的会话操作完还埋在列表底部;而且"近7天"筛选按创建时间滤,刚操作完的旧会话直接被默认筛选滤掉,看起来又"消失"了。修复:扫盘时把会话文件 mtime 带出来(claude 实时追加写,mtime 就是最近操作时间;codex 每轮 resume 写新 rollout,`dedupeById` 合并同一会话的多轮文件时取**最新**文件的 mtime),`lastActivityAt = max(task更新时间, 文件mtime, 创建时间)`,排序和筛选都用它。"近N天"语义从"创建于近N天"改成"近N天内有动静"
- **内嵌终端里中文输入法的标点永远是英文符号**(`TerminalView.tsx` 的 `imePunctuationFix`):埋点实测——中文输入法激活时按逗号,Electron 报的 keydown 是**真实键码**(`keyCode=188, isComposing=false`),而不是真 Chrome 浏览器里的 `keyCode=229`("输入法正在处理这个键")信号。xterm.js 的 keydown 处理器于是把它当普通可打印字符:preventDefault + 直接发送 ASCII `,`,而输入法的全角标点转换("，")是发生在 keydown **之后**、经 insertText 送达的——preventDefault 把这条管线整个掐死了,所以转换永远不发生。同一窗口的普通输入框(新对话的任务描述)标点正常,证明窗口级输入法联动没坏,问题只在 xterm 的 keydown 抢跑。修复:在 container 上以 capture 阶段拦一层——对"无修饰键、非组合中、单字符可打印"的 keydown 调 `stopImmediatePropagation()` 但**不** preventDefault,xterm 收不到 keydown,浏览器默认文本输入管线照常跑:输入法转换结果经 insertText 到达 helper textarea,由 xterm 现成的 `_inputEvent` 通道发送(这正是真浏览器里 keyCode=229 按键的既有路径);纯 ASCII 则经 keypress 由 `_keyPress` 发送;xterm 用 `_keyDownSeen`/`_keyPressHandled` 内部标志保证不双发。修饰键/Ctrl/Cmd/回车/退格/方向键/组合输入中的按键全部不拦,走 xterm 原路径
- **目录信任提示 + 一键信任**(`agentConfig.ts` 的 `getDirTrust`/`setDirTrusted` + `NewTaskForm.tsx`):新建对话时如果目录未被信任,Codex/Claude 会**忽略该目录自己的权限白名单**(Claude 报"Ignoring N permissions.allow entries from .claude/settings.local.json")——因为信任标记只能通过交互式的信任对话框产生,而 AgentHub 对话模式是 headless 弹不了框。表单里填了目录后会自动查询两边信任状态(状态行显示 Codex ✓/✗ · Claude ✓/✗),未信任时给"信任此目录"按钮:点击后 codex 侧往 config.toml 外科手术式写入/替换 `[projects."<path>"]` 的 `trust_level = "trusted"`(已有 untrusted 块原地替换,幂等),claude 侧 JSON merge 进 `~/.claude.json` 的 `projects[cwd]`(保留该条目其它字段)。刻意做成**显式按钮**而不是静默自动信任:信任一个目录等于激活它的本地权限白名单,这正是 Claude Code 交互式信任对话框要问的安全决策,不该被 AgentHub 替用户默默做掉
- **Claude 会话的 fallback 标题**(`inspector.ts` 的 `getClaudeHistory` + `ConversationSidebar.tsx`):原来 Claude 侧历史扫描只认 `ai-title`(Claude 自己异步生成的标题,短对话可能永远不生成),终端模式新会话在 ai-title 出现前标题为空,侧边栏直接 fallback 显示**整个目录路径**。现在没有 ai-title 时取第一条真实用户消息前 80 字符当标题(跳过 `isMeta` 条目和 `<` 开头的注入内容如 `<command-name>`/`<local-command>`),ai-title 出现后仍然优先;标题彻底为空的兜底也从全路径改成目录名(meta 行本来就显示了完整 cwd,标题再放全路径又长又重复)。另外排查过"Claude Code 存量项目信任死锁":老项目条目 `hasCompletedProjectOnboarding: true` 但 `hasTrustDialogAccepted: false` 时,**即使交互式 cd 进目录启动也永远不会再弹信任框**(信任框只在首次发现新目录时弹),只能手动修配置——一键信任按钮正是给这个场景准备的
- **过滤一次性派发的 Codex 会话**(`inspector.ts` 的 `getCodexHistory` + `readConfiguredModelProviders`):用户自己的 orchestrator 派单系统跑 `codex` 时用 CLI `-c` 临时 override 指定 provider(名字如 `orchestrator_override`,定义只在那一次命令里,不落 config.toml),这些会话的 `session_meta` 永久记住了这个 provider 名——之后任何方式 resume 都会硬报错 `Model provider 'xxx' not found` 退出(实测 AgentHub 外直接跑同样报错,非 AgentHub 问题)。过滤规则:会话记录的 `model_provider` 不在当前 config.toml 的 `[model_providers.*]` 里(内置名单只有小写 `openai`/`oss`)的直接不进列表。**踩过一次坑**:第一版把大写 `OpenAI` 也当成"老版本内置 provider 的写法"加进白名单——错了,实测那 7 条大写 `OpenAI` 会话 resume 照样报 `OpenAI not found` 退出(大写是历史 CLI override 的产物,大小写并不代表它是内置 provider),控制组(xingsuancode,config 里有定义)resume 正常。教训:这类"可行性"判断不要靠命名推断,要么实测要么按最严格规则来。该规则同时把"resume 必然失败"的会话全部排除,一举两得。之前对这些会话只能做"重复标题聚合"(`collapseBursts`),现在按 provider 根因直接整类过滤,聚合逻辑保留兜底其它来源的噪音。另注:aicoding provider 的 `env_key`(`OPENAI_API_KEY_0011AI`)在登录 shell 里并不存在,但其会话 resume 不看这个(2026-03 的 aicoding 会话 resume 能正常进 TUI,provider 定义存在即可)

## 明确的已知限制

- Codex 历史会话里的工具调用还原是 best-effort——`custom_tool_call.input` 有时是一段 JS 胶水代码(`const r = await tools.exec_command({cmd:...})`)而不是干净命令,展示上不如 Claude 那边整洁(Claude 磁盘格式就是标准 Anthropic Messages 格式,能干净还原)
- 超大 session 文件(10MB 级别)整份读入内存解析,首次打开历史对话可能有感知得到的延迟,没做虚拟滚动/分页
- `conversations:list` 磁盘扫描上限 200 条,不是全部历史
- 内嵌终端(PTY 模式)完全不经过 `TaskRunner`,所以侧栏"运行中"小圆点、Codex 失败自动交接给 Claude 这些功能只对"对话"模式生效,终端模式里失败了不会自动交接——设计取舍,不是遗漏
- PTY 输出 buffer 有 200KB 截断上限,关掉 AgentHub 再打开、或者 buffer 溢出后,超出部分的终端历史看不到了(但底层 session 文件是完整的,切回"对话"模式看完整历史还原不受影响)
- Codex 那些用 `env_key` 指定环境变量的 provider(比如已有配置里的某个 provider),它们的 key 存在用户 shell 环境变量里,AgentHub 管不到也不该管——API 配置面板管理的是一个专属的 `agenthub` provider,不影响用户已有的其它 provider 定义,只是把"当前生效的 provider"切换过去
- Claude 这边如果用户之前是用 shell 里 `export ANTHROPIC_BASE_URL=...` 配的(不是写在 settings.json 里),AgentHub 保存后 settings.json 和 shell 环境变量会并存,而 shell 环境变量的优先级通常更高,面板保存了但终端里可能看不出变化——这是环境变量覆盖顺序的固有行为,不是 bug
- 只清空 Base URL(不同时提供新 key)不会把已经写成 `ANTHROPIC_AUTH_TOKEN` 的 key 自动降级回 `ANTHROPIC_API_KEY`——`hasApiKey` 会继续显示"已配置",但如果想真正切回官方直连,需要连 key 一起重新填一次;已实测确认这个行为,不是遗漏

## 路线图 / 明确未做

- `claude --bg` + `claude agents --json` 的脱离 App 生命周期后台模式(当前用前台 spawn 捕获流)
- 系统通知
- Claude Code 失败自动切回 Codex（已支持手动携带记忆切换）
