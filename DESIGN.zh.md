# dsh-guard-hooks 设计文档（Claude Code 式 Hooks 插件 for DSH）

> 目标：把对比文档里的 P0 差距「Hooks 钩子系统」补上，以 Cordis 插件形态交付，
> 用户零代码配置：写 YAML 就能用，同时保留脚本钩子的全部表达力。

## 1. 交付物

- 规范 npm 包 `dsh-guard-hooks`（ESM，纯 JS + JSDoc 类型，无构建步骤，node >= 20 可直接跑）
- 挂载方式：装进 profile 的 node_modules，`cordis.patch.yml` 加一行
- 配置：`~/.dsh/hooks.yaml`（用户级）+ `<repo>/.dsh/hooks.yaml`（项目级，深合并覆盖）

## 2. 事件模型

| Hook 事件 | Claude Code 对应 | 触发时机 | 可否拦截 |
|---|---|---|---|
| `PreToolUse` | PreToolUse | 工具执行前，拿到 `{tool, input}` | ✅ deny 阻断并回灌原因 |
| `PostToolUse` | PostToolUse | 工具执行成功后，拿到 `{tool, input, output}` | ❌ 仅观察/反馈 |
| `UserPromptSubmit` | UserPromptSubmit | 用户提示词入库前 | ✅ 可阻断、可注入上下文 |
| `Stop` | Stop | agent 回合结束 | ❌ |
| `PreCompact` | PreCompact | 上下文压缩前 | ❌ |
| `SessionStart` | SessionStart | 会话创建/恢复 | ❌ |

> 与 CC 的已知差异：Notification / SubagentStop / SessionEnd 三事件未实现（审批提醒场景由 notify.onApprovalWait 部分覆盖）；Stop 是通知型钩子，不支持 CC 的「block 强制继续回合」语义。

每个事件可挂多条 hook；每条 hook：

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash|Pwsh"      # 正则，匹配工具名；省略 = 全部
      command: "pwsh -NoProfile -File C:/scripts/guard.ps1"
      timeoutMs: 10000          # 默认 10s；超时视为非阻塞失败
      async: false              # true = 发射后不管（通知类用）
```

### 脚本协议（对齐 Claude Code）

- stdin 收到 JSON 事件载荷：`{event, sessionId, cwd, tool?, input?, output?, prompt?}`
- 环境变量：`DSH_EVENT` / `DSH_TOOL_NAME` / `DSH_SESSION_ID` / `DSH_CWD`
- **退出码语义**：
  - `0` 放行；stdout 在 PostToolUse 里作为附加上下文回灌
  - `2` 拦截：stderr（或 stdout JSON 的 reason）作为拒绝原因回给模型
  - 其他非零：非阻塞错误，只记审计不干预
- **stdout JSON 决策**（优先于退出码）：
  `{"decision":"block","reason":"..."}` / `{"decision":"approve"}` / `{"additionalContext":"..."}`
- 对齐范围是经典协议：CC 新版 `hookSpecificOutput.permissionDecision` 语法与 Stop 拦截语义不在范围内

## 3. 内置功能（免脚本层）

### 3.1 危险命令拦截 rules（PreToolUse 内置规则引擎）

```yaml
rules:
  deny:   # 命中直接拒，reason 回灌模型
    - "/rm -rf ~?\\//i"   # 子串级正则：复合命令里夹带的片段也命中
    - "rm -rf /*"
    - "Remove-Item -Recurse -Force C:\\*"
    - "git push --force*main*"
  ask:    # 命中转人工审批（若运行时支持）否则拒
    - "npm publish*"
  allow:  # 命中直接放行，跳过后续 hook
    - "git status*"
    - "pnpm *test*"
```

匹配目标 = Bash/Pwsh 类工具的 command 输入串；支持 glob（picomatch 语义，DSH 自带依赖）
与 `/regex/` 形式。注意通配是**锚定全串匹配**（等价 `^…$`），复合命令里夹带的危险片段要用不锚定的 `/regex/i` 正则形式检测。

### 3.2 formatOnSave（PostToolUse 内置）

```yaml
formatOnSave:
  - match: "*.ts,*.tsx,*.js,*.jsx,*.json,*.md,*.css"
    command: "npx prettier --write {file}"
  - match: "*.py"
    command: "ruff format {file} && ruff check --fix {file}"
```

- 触发条件：编辑类工具成功写入且扩展名命中
- `{file}` 占位符替换为绝对路径；命令在工作区根执行；默认 30s 超时
- 失败非阻塞：stderr 摘要作为工具后注释回灌模型（可选开关）

### 3.3 notify（Stop / 等待审批时桌面通知）

```yaml
notify:
  onStop: true          # Windows toast（BurntToast 缺失时退化为 balloon tip）
  onApprovalWait: true
  sound: true
```

实现：内嵌 PowerShell 单行脚本，无第三方依赖。

### 3.4 audit 审计日志

```yaml
audit:
  enabled: true
  path: "~/.dsh/audit/hooks.jsonl"   # 每行一个 JSON 事件
  redact: ["Authorization", "*key*"] # 敏感字段打码
```

记录：所有工具调用（名称+输入摘要+结果状态+耗时）、hook 执行记录、拦截事件。

### 3.5 webhook

```yaml
webhook:
  url: "https://example.com/hook"
  events: [Stop, PreToolUse]
  headers: { X-Token: "..." }
```

POST JSON 事件载荷，fire-and-forget，失败只记日志。

## 4. 进程与安全设计

- hook 命令经 spawn 执行，**绝不经过 agent 的 shell 工具**，不受沙箱策略影响（插件运行在宿主进程）
- 所有 hook 失败均隔离：插件自身抛错不能带崩会话（顶层 try/catch + 日志）
- 并发：同一事件的 hooks 顺序执行（保证确定性），不同事件互不等待
- 超时 kill 进程树；async 模式不阻塞主流程

## 5. 配置合并规则

`~/.dsh/hooks.yaml` 与项目 `.dsh/hooks.yaml` 深合并：
- 标量/对象递归覆盖；数组（hooks.*、rules.*、formatOnSave）拼接（项目级追加在后）
- 项目级可设 `inherit: false` 完全忽略用户级
- YAML 解析失败 → 明确报错到 DSH 日志并禁用对应层，不影响另一层
