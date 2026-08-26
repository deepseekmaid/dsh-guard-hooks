# dsh-guard-hooks

Claude Code 式 **Hooks 钩子系统**，以 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) Cordis 插件形态交付。写 YAML 就能用：危险命令拦截、存盘自动 format/lint、桌面通知、审计日志、Webhook 推送，外加与 Claude Code 协议兼容的脚本钩子（stdin JSON / 退出码语义）。

[English](README.md) | 中文

## 为什么需要它

DSH 的扩展点是 Cordis 插件——能力很强但要写 npm 包；Claude Code 用户早已习惯在 `settings.json` 里配几行钩子实现「存盘自动 prettier」「rm -rf 拦截」「回合结束桌面提醒」。`dsh-guard-hooks` 把这套体验带给 DSH：

| 能力 | Claude Code | dsh-guard-hooks |
|---|---|---|
| 钩子配置 | `settings.json` 的 `hooks` 段 | `~/.dsh/hooks.yaml`（用户级）+ `.dsh/hooks.yaml`（项目级分层） |
| 事件 | PreToolUse / PostToolUse / UserPromptSubmit / Stop / PreCompact / SessionStart（另有 Notification / SubagentStop / SessionEnd） | 同名六事件 ✅；CC 的 Notification / SubagentStop / SessionEnd 暂无对应，Stop 为通知型、不能拦截回合 |
| 危险命令拦截 | 要自己写脚本 | 内置 `rules:` 规则表，零脚本 ✅ |
| 脚本协议 | stdin JSON + exit 0/2 + stdout 决策 JSON（经典协议）；新版另有 hookSpecificOutput.permissionDecision | 经典协议对齐 ✅；hookSpecificOutput 语法暂未支持 |
| 存盘格式化 | 社区方案 | 内置 `formatOnSave:` ✅ |
| 桌面通知 | iTerm2/bell 等 | Windows toast（零依赖）✅ |

## 安装

```powershell
# 方式一（推荐）：装进 profile，自动挂载
dsh plugin --profile web add C:\path\to\dsh-guard-hooks
# 包内自带 cordis.patch.yml bundle 声明，重启即生效
```

**从 npm 安装**（装到共享池目录，再按下方「手动挂载」接挂载行）：

```powershell
npm i dsh-guard-hooks --prefix <共享池目录>
```

**手动挂载**（注意相对路径锚点是 profile 目录，包在共享池要写 `../`）：

```yaml
# <profile>\cordis.patch.yml
- insert:
    - id: dsh-guard-hooks
      name: dsh-guard-hooks                              # 装在 <profile>\node_modules 时用裸包名
      # 或：../node_modules/dsh-guard-hooks/lib/index.js?v=4   # 装在共享池；?v=N 用于热换代码版本
```

> ⚠️ 两个坑：① 写 `./node_modules/...` 会指到 profile 目录内部，启动时 MODULE_NOT_FOUND 且 fail-loud 拒绝启动；
> ② 插件源码更新后热重载不会自动换模块——把 `?v=N` 加一即可强制重导入。

## 快速开始

创建 `~/.dsh/hooks.yaml`：

```yaml
rules:
  deny:
    - "/rm -rf ~?\\//i"   # 正则子串匹配：复合命令里夹带的 rm -rf / 或 rm -rf ~/ 也拦得住
    - "rm -rf /*"
    - "Remove-Item*-Recurse*-Force*C:\\*"
    - "git push --force*main*"
  warn:
    - "git reset --hard*"
  allow:
    - "git status"
    - "git log*"

formatOnSave:
  rules:
    - match: "*.ts,*.js,*.json,*.md"
      command: "npx prettier --write {file}"
    - match: "*.py"
      command: "ruff format {file}"

notify:
  onStop: true        # 回合结束弹 toast
```

保存即热生效，无需重启 DSH。完整字段见 [`examples/hooks.example.yaml`](examples/hooks.example.yaml)。

## 配置参考

### 层叠规则

1. `~/.dsh/hooks.yaml` — 用户级基线
2. `<仓库根>/.dsh/hooks.yaml` … `<cwd>/.dsh/hooks.yaml` — 项目级，浅层先合并、深层覆盖
3. 数组跨层**追加**（hooks.* / rules.* / formatOnSave.rules）；对象深合并；项目级写 `inherit: false` 可完全脱离用户级

### rules —— 危险命令拦截（免脚本）

对 Bash/Pwsh 类工具的输入串求值，顺序 `deny → ask → warn → allow`：

```yaml
rules:
  deny:   # 命中直接拒，原因回灌模型
    - "rm -rf /*"            # 通配：* 匹配任意字符（含空格），? 单字符
    - "/DROP TABLE .*/i"     # /…/ 形式 = 正则，尾部 i = 忽略大小写
  ask:    # 命中转人工审批门（DSH approval 流程，fail-closed）
    - "deploy *"
  warn:   # 命中放行但回灌警示
    - "npm publish*"
  allow:  # 命中直接放行，跳过其余钩子
    - "git status"
```

工具名与规则匹配均为**大小写不敏感**（真实注册表里 `pwsh`/`Pwsh` 都存在）。

> **通配是锚定全串匹配**：模式要求整条输入从头到尾命中（等价 `^…$`），所以 `rm -rf /*` 拦得住 `rm -rf / --no-preserve-root`，拦不住 `cd /tmp; rm -rf /` 这类复合命令。要按**子串**检测请写 `/…/i` 正则形式（"包含即命中"，不锚定），例如 `/rm -rf ~?\//i` 能在任意位置拦下递归删除根目录/家目录的片段。

### hooks —— 脚本钩子（Claude Code 协议）

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash|Pwsh"     # 正则匹配工具名（大小写不敏感），省略 = 全部
      command: "pwsh -NoProfile -File C:/scripts/guard.ps1"
      timeoutMs: 10000         # 超时杀进程树（钳制在 100ms~10min），视为非阻塞失败
      async: false             # true = 发射后不管（全局并发上限 8）
      shell: "powershell"      # 可选：自定义 shell；false = 直接 argv 派发不经过 shell
```

**脚本协议**：

- stdin 收到 JSON：`{event, sessionId, cwd, timestamp, tool?, input?, output?, prompt?}`
- 环境变量：`DSH_EVENT` `DSH_TOOL_NAME` `DSH_SESSION_ID` `DSH_CWD`
- **退出码**：`0` 放行（PostToolUse 的 stdout 作为附加上下文回灌）；`2` 拦截（stderr 为拒绝理由）；其他 = 非阻塞错误只记审计
- **stdout JSON 决策**（优先于退出码）：PreToolUse `{"decision":"block","reason":"…"}` / `{"decision":"approve"}`；PostToolUse 同样可 block（成功结果被打成纠正性错误）；另有 `{"additionalContext":"…"}` 注入上下文

### formatOnSave —— 存盘自动格式化

编辑类工具成功写入且路径命中 glob 时执行（扩展名匹配忽略大小写）；失败不阻断，stderr 尾部可回灌给模型让它自己修（`reportErrors: true`）。`{file}` 与 `"{file}"` 占位符都会替换为带引号的绝对路径（含空格路径安全）。

### notify —— 桌面通知

```yaml
notify:
  onStop: true          # agent 回合结束时
  onApprovalWait: true  # 等待人工审批时
  onIntercept: true     # 规则/钩子拦截发生时
  sound: false
```

Windows 上经内置 PowerShell balloon tip 实现（Win10/11 自动渲染为 toast），无第三方依赖；内置防风暴限速。

### audit —— 审计日志

```yaml
audit:
  enabled: true
  path: "~/.dsh/audit/hooks.jsonl"
  redact: ["authorization", "*key*", "*token*", "*secret*", "*password*"]  # 默认值
```

每行一个 JSON 事件：`tool-call`（工具调用+耗时+结果状态）、`hook-run`（钩子执行记录含 stderr 尾巴）、`interception`（deny/ask/warn 拦截）、`turn-stop`、`compaction`、`prompt`、`session-start`、`approval-request`。超过 `maxBytes`（默认 20MB）自动轮转为 `<path>.1`。

### webhook —— 外推

```yaml
webhook:
  url: "https://example.com/hook"
  events: [Stop]          # 空 = 全部事件
  headers:
    X-Token: "xxx"
  secret: "shared-hmac-key"   # 可选：自动加 X-DSH-Signature: sha256=<hex> 签名头
```

POST JSON，fire-and-forget，失败只记日志。

## 设计保证

- **绝不炸会话**：钩子进程超时即杀（Windows 下 taskkill /T /F 杀树）；异步钩子并发上限 8；插件自身所有路径 fail-safe
- **配置永不断电**：YAML 写坏/读一半时保持上一个好快照（deny 规则不因 typo 失效），修复后自动恢复；坏层只告警一次
- **零未声明依赖**：不读取任何未 inject 声明的 Cordis 服务（Context 代理对未声明属性访问会抛错——这条铁律曾用一次真实死锁换来）
- **不经沙箱**：钩子由宿主进程直接 spawn，与 agent 的 shell 工具沙箱策略互不影响
- **热重载**：改 `hooks.yaml` 即生效；插件代码更新后把挂载行 `?v=N` 加一强制热换，或重启 DSH
- **协议兼容（经典版）**：stdin JSON、退出码 0/2、stdout 决策 JSON 与 Claude Code Hooks 对齐，现有脚本文档基本可直接照搬；CC 新版 `hookSpecificOutput.permissionDecision` 语法、Stop 钩子拦截语义与 Notification / SubagentStop / SessionEnd 三事件暂未支持

## 排障速查

| 症状 | 原因 | 处理 |
|---|---|---|
| 加插件后 DSH 启动即报 `ERR_MODULE_NOT_FOUND` | 挂载说明符锚错目录（`./node_modules/...` 相对的是 profile 内层目录） | 改用裸包名或 `../node_modules/<pkg>/lib/index.js?v=N` |
| 改了插件代码但行为没变 | 热重载只盯配置文件，不追模块源码 | 把挂载行 `?v=N` 加一，或重启 DSH |
| 编辑 hooks.yaml 后规则突然不匹配 | YAML 写坏了，加载器保持上一个好快照 | 修好语法，保存后自动恢复 |
| 日志出现 `pre-step interrupted by host (cause: {"kind":"user"})` | 你打断/插话了正在运行的回合——正常取消控制流 | 无需处理 |
| 钩子输出没进审计 | 钩子是 `async: true`，或在写 stdout 前就崩了 | 看 `hook-run` 记录里的 stderr 尾巴 |

## 分享给别人

把整个文件夹发给对方，对方只需要（Node ≥ 20 + 已装 DSH）：

```powershell
dsh plugin --profile web add C:\解压路径\dsh-guard-hooks   # pnpm 自动装依赖并挂载
dsh web                                                    # 重启生效
```

然后把 [`examples/hooks.example.yaml`](examples/hooks.example.yaml) 复制为 `~/.dsh/hooks.yaml` 按需修改即可。

## License

MIT
