/**
 * Format-on-save: run a formatter/linter on files written by edit-class tools
 * (PostToolUse), keyed by glob match against the written path.
 *
 * Failures never block; with `reportErrors` the first stderr lines travel
 * back to the model as additional context so it can fix style itself.
 *
 * @module dsh-guard-hooks/features/format
 */

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { runHook } from "../engine.js";
import { matchGlobList } from "../patterns.js";

/** Tools whose success means "a file was written". Case-insensitive; covers
 * native names (`edit`, `write`) and registry names (`StrReplaceEditor`). */
export const EDIT_TOOL_PATTERN = "Edit|Write|StrReplace|Notebook|Fs|Patch|Apply";

/**
 * Extract candidate file paths from an edit tool's input/output.
 *
 * @param {object} input - tool arguments.
 * @param {object} [output] - tool result (some tools report paths here).
 * @returns {string[]} absolute-ish paths, best effort.
 */
export function extractPaths(input, output) {
	const paths = new Set();
	const consider = (value) => {
		if (typeof value === "string" && value.includes("/") || typeof value === "string" && value.includes("\\")) {
			paths.add(value);
		}
	};
	for (const key of ["path", "file_path", "filePath", "filename", "file", "target"]) {
		if (typeof input === "object" && input !== null) consider(input[key]);
	}
	if (output && typeof output === "object") {
		for (const key of ["path", "file_path", "filePath"]) consider(output[key]);
	}
	return [...paths];
}

/**
 * Run every matching formatOnSave rule for one written file.
 *
 * @param {object} formatConfig - merged `formatOnSave` config.
 * @param {string} filePath - written file path.
 * @param {string} cwd - workspace root for command execution.
 * @returns {Promise<{ran: number, contexts: string[]}>}
 */
export async function formatFile(formatConfig, filePath, cwd) {
	if (!formatConfig?.enabled) return { ran: 0, contexts: [] };
	const contexts = [];
	let ran = 0;
	for (const rule of formatConfig.rules ?? []) {
		if (!matchGlobList(rule.match, filePath)) continue;
		const command = interpolateFilePath(rule.command, filePath);
		const workdir = existsSync(dirname(filePath)) ? dirname(filePath) : cwd;
		const result = await runHook({
			command,
			payload: { event: "formatOnSave", file: filePath },
			timeoutMs: rule.timeoutMs ?? formatConfig.timeoutMs ?? 30_000,
			cwd: workdir,
			env: { DSH_FORMAT_FILE: filePath }
		});
		ran += 1;
		if (!result.ok) {
			const detail = result.stderrTail || result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(0, 5).join("\n");
			contexts.push(`[hooks] formatOnSave 对 ${filePath} 执行失败: ${command}${detail ? `\n${detail}` : ""}`);
		}
	}
	return { ran, contexts: formatConfig.reportErrors === false ? [] : contexts };
}

/**
 * Replace `{file}` / `"{file}"` with a properly double-quoted shell-safe
 * path. Handles both bare and already-quoted placeholders so user commands
 * like `prettier --write "{file}"` and `prettier --write {file}` both work,
 * including paths containing spaces. Windows path components cannot contain
 * double quotes, so they are stripped there; POSIX filenames can, so they
 * are escaped instead of dropped.
 */
export function interpolateFilePath(command, filePath) {
	const safe = process.platform === "win32" ? String(filePath).replace(/"/g, "") : String(filePath).replace(/"/g, '\\"');
	const quoted = `"${safe}"`;
	return String(command).replace(/"?\{file\}"?/g, quoted);
}

/**
 * True when any formatOnSave rule matches this extension — used to skip
 * spawning formatters when the table has nothing to say about the file.
 */
export function hasRuleForPath(formatConfig, filePath) {
	return (formatConfig?.rules ?? []).some((rule) => matchGlobList(rule.match, filePath));
}
