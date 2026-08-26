# dsh-guard-hooks

Claude Code-style **hooks** for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness), delivered as a Cordis plugin. Configure in YAML: dangerous-command interception, human approval gates, format-on-save, desktop notifications, audit log, webhook push — plus script hooks fully compatible with the Claude Code protocol (stdin JSON / exit-code semantics).

English | [中文](README.zh.md)

## Install

**From a local folder** (e.g. someone shared this directory with you):

```powershell
# Dependencies (js-yaml, picomatch) are resolved automatically via pnpm,
# and the bundled patch mounts the plugin into your profile.
dsh plugin --profile web add C:\path\to\dsh-guard-hooks

# then restart DSH:
dsh web
```

Requirements: Node.js >= 20 and a working DSH install.

**Manual mount** (if you prefer copying files yourself): copy the package into `<profile>\node_modules\dsh-guard-hooks` (run `npm install --omit=dev` inside it once), then add to `<profile>\cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-guard-hooks
      name: ../node_modules/dsh-guard-hooks/lib/index.js?v=1   # relative to <profile>\web
      # or bare name when installed under <profile>\node_modules:
      # name: dsh-guard-hooks
```

> ⚠️ Two pitfalls: ① a leading `./node_modules/...` anchor resolves against the
> inner profile dir (`<profile>\web`) — wrong by one level, and DSH refuses to
> boot on the missing module. Use `../node_modules/...` from the shared pool or
> a bare package name. ② hot reload watches *config*, not plugin source: after
> editing plugin code, bump the `?v=N` query to force a fresh module import, or
> restart DSH.

## Quick start

Create `~/.dsh/hooks.yaml`:

```yaml
rules:
  deny:
    - "/rm -rf ~?\\//i"   # substring regex: catches rm -rf / even inside compound commands
    - "rm -rf /*"
    - "Remove-Item*-Recurse*-Force*C:\\*"
    - "git push --force*main*"
    - "shutdown*"
  warn:
    - "git reset --hard*"
    - "/DROP TABLE/i"
  allow:
    - "git status*"
    - "git log*"
    - "git diff*"

notify:
  onStop: true   # toast when a turn ends

audit:
  enabled: true
  path: "~/.dsh/audit/hooks.jsonl"
```

Save → effective within ~2 s, no restart. Full field reference: [`examples/hooks.example.yaml`](examples/hooks.example.yaml).

## Configuration reference

### Layering

1. `~/.dsh/hooks.yaml` — user baseline
2. `<repo-root>/.dsh/hooks.yaml` … `<cwd>/.dsh/hooks.yaml` — project layers, shallow first, deeper overrides
3. Arrays **append** across layers (`hooks.*`, `rules.*`, `formatOnSave.rules`); objects deep-merge; a project file with `inherit: false` detaches from the user layer entirely

A broken YAML never disarms you: the loader keeps the last good snapshot (deny rules survive typos), warns once, and recovers automatically after you fix the file.

### rules — interception without scripts

Evaluated against shell-tool input in order `deny → ask → warn → allow`. Tool names and patterns match case-insensitively.

```yaml
rules:
  deny:     # block outright, reason fed back to the model
    - "rm -rf /*"            # wildcards: * any run (incl. spaces), ? single char
    - "/DROP TABLE .*/i"     # /…/i form = regex with ignore-case
  ask:      # route through the DSH human approval gate (fail-closed)
    - "npm publish*"
  warn:     # pass, but attach a caution note for the model
    - "npm publish*"
  allow:    # pass and skip remaining PreToolUse hooks (saves hook latency)
    - "git status*"
```

Wildcard patterns are **anchored to the whole input** (`^…$`): `rm -rf /*` catches `rm -rf / --no-preserve-root` but NOT a dangerous fragment buried in a compound command like `cd /tmp; rm -rf /`. For substring detection use the `/…/i` regex form (unanchored), e.g. `/rm -rf ~?\//i`.

### hooks — script hooks (Claude Code protocol)

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash|Pwsh"     # regex over tool names (case-insensitive); omit = all
      command: "pwsh -NoProfile -File C:/scripts/guard.ps1"
      timeoutMs: 10000         # clamped to [100ms, 10min]; timeout kills the tree
      async: false             # true = fire-and-forget (global concurrency cap: 8)
      shell: "powershell"      # optional custom shell; false = spawn argv directly
```

Script contract:

- stdin JSON: `{event, sessionId, cwd, timestamp, tool?, input?, output?, prompt?}`
- env vars: `DSH_EVENT`, `DSH_TOOL_NAME`, `DSH_SESSION_ID`, `DSH_CWD`
- **exit codes**: `0` pass (PostToolUse stdout becomes additional context); `2` block (stderr is the reason); anything else = non-blocking error, audited only
- **stdout decision JSON** wins over exit codes: PreToolUse `{"decision":"block","reason":"…"}` / `{"decision":"approve"}`; PostToolUse can also block (turns a successful result into a corrective error); `{"additionalContext":"…"}` injects context
- Compatibility scope: this mirrors the *classic* Claude Code protocol — the newer `hookSpecificOutput.permissionDecision` syntax and blocking Stop hooks are not supported

### formatOnSave

Runs when an edit-type tool writes a file whose path matches the glob (extension match ignores case). Failures never block the edit; with `reportErrors: true` the tail of stderr is fed back so the model fixes its own formatting. `{file}` / `"{file}"` become a quoted absolute path (space-safe).

### notify

```yaml
notify:
  onStop: true          # turn ended
  onApprovalWait: true  # waiting for your approval
  onIntercept: true     # something was blocked
  sound: false
```

Windows balloon tip rendered as toast on Win10/11; no third-party dependencies; rate-limited against storms.

### audit

```yaml
audit:
  enabled: true
  path: "~/.dsh/audit/hooks.jsonl"
  maxBytes: 20971520          # rotate to <path>.1 beyond 20 MB
  redact: ["Authorization", "*key*", "*token*", "*secret*", "*password*"]
```

One JSON object per line: `tool-call` (with duration + result state), `hook-run` (with stderr tail), `interception` (deny/ask/warn hits), `prompt`, `turn-stop`, `compaction`, `session-start`, `approval-request`.

### webhook

```yaml
webhook:
  url: "https://example.com/hook"
  events: [Stop]            # empty = all events
  headers:
    X-Token: "xxx"
  secret: "shared-hmac-key" # adds X-DSH-Signature: sha256=<hex> HMAC header
  timeoutMs: 5000
```

Fire-and-forget POST; failures are logged only.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| DSH fails to boot with `ERR_MODULE_NOT_FOUND` right after adding the plugin | mount specifier anchored at the wrong directory (`./node_modules/...`) | use a bare name or `../node_modules/<pkg>/lib/index.js?v=N` |
| Edited plugin code but behavior unchanged | hot reload tracks config files, not module source | bump `?v=N` in the mount line, or restart DSH |
| Rules stopped matching after editing hooks.yaml | YAML typo — loader kept the previous good snapshot | fix the syntax; it recovers on next save |
| Log shows `pre-step interrupted by host (cause: {"kind":"user"})` | you interrupted/steered a running turn — normal cancel control-flow | nothing to do |
| Hook output missing from audit | hook declared `async: true` or crashed before writing stdout | check the `hook-run` record's stderr tail |

## Design guarantees

- **Never crashes the session**: timeouts kill process trees; async hooks capped at 8 concurrent; every failure path is isolated and audited
- **Config never disarms protection**: broken YAML keeps the last good snapshot until fixed
- **Zero undeclared service reads**: the plugin never touches Cordis context services without an `inject` declaration (context proxies throw on undeclared property access — learned the hard way)
- **Outside the agent sandbox**: hooks are spawned by the host process; shell-tool sandboxing does not affect them
- **Protocol-compatible (classic)**: stdin JSON, exit codes 0/2, and stdout decision JSON match Claude Code Hooks conventions, so most existing scripts/docs port directly; the newer permissionDecision syntax and the Notification / SubagentStop / SessionEnd events are not covered

## License

MIT
