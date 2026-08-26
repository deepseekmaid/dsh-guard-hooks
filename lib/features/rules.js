/**
 * Built-in command rule table evaluated against shell-tool inputs on
 * PreToolUse, before any script hook runs. Four tiers, checked in order:
 *
 * - `deny`:  block the tool call; the matched rule is fed back as the reason.
 * - `ask`:   force the human-approval gate (`{kind:'ask'}` on the DSH gate);
 *            fail-closed if no approval service answers allowed-once.
 * - `warn`:  pass, but surface a caution note back to the model post-execute.
 * - `allow`: pass immediately and short-circuit later hooks for this call.
 *
 * @module dsh-guard-hooks/features/rules
 */

import { compileAny } from "../patterns.js";

/** Evaluation order. */
export const RULE_ORDER = ["deny", "ask", "warn", "allow"];

/**
 * Evaluate the rule table against one shell input.
 *
 * @param {object} rules - `{deny:[], ask:[], warn:[], allow:[]}` from merged config.
 * @param {string} input - the raw command text the tool is about to run.
 * @returns {{ action: "allow"|"ask"|"deny"|"warn"|"none", pattern?: string }}
 */
export function evaluateRules(rules, input) {
	if (!rules || typeof input !== "string") return { action: "none" };
	for (const action of RULE_ORDER) {
		const patterns = rules[action];
		if (!Array.isArray(patterns) || patterns.length === 0) continue;
		if (compileAny(patterns)(input)) {
			return { action, pattern: matchOf(patterns, input) };
		}
	}
	return { action: "none" };
}

/** Find which single pattern matched (for reporting); linear rescan, cheap at these sizes. */
function matchOf(patterns, text) {
	for (const pattern of patterns ?? []) {
		try {
			if (compileAny([pattern])(text)) return String(pattern);
		} catch {
			continue;
		}
	}
	return undefined;
}

/** Human-facing denial reason fed back to the model. */
export function denialReason(result, toolName) {
	return [
		`hooks: ${toolName} 调用被危险命令规则拦截`,
		result.pattern ? `命中规则: ${result.pattern}` : "",
		"这条命令被 ~/.dsh/hooks.yaml 的 rules.deny 禁止。如确需执行，请让用户修改 hooks.yaml 或改用等价的安全命令。"
	]
		.filter(Boolean)
		.join("\n");
}

/** Reason string for the human-approval gate (`rules.ask` hits). */
export function askReason(result, toolName) {
	return [`hooks 规则命中需人工确认`, result.pattern ? `匹配: ${result.pattern}` : "", `工具: ${toolName}`].filter(Boolean).join(" | ");
}

/** Caution line appended to context on warn hits. */
export function warningNote(result, toolName) {
	return `[hooks] 注意: ${toolName} 输入命中谨慎规则${result.pattern ? ` "${result.pattern}"` : ""}，请确认这是用户想要的操作。`;
}

/**
 * Which tools count as shell tools for rule evaluation. Case-insensitive;
 * covers native (`pwsh`, `bash`) and registry (`Terminal`, `Shell`) names.
 */
export const SHELL_TOOL_PATTERN = "Bash|Pwsh|Shell|Terminal|Cmd|Zsh|Sh";
