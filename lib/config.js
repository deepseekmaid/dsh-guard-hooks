/**
 * Configuration loading and merging for dsh-guard-hooks.
 *
 * Layers (lowest → highest priority):
 *   1. `~/.dsh/hooks.yaml`                       — user level
 *   2. `<repo-root>/.dsh/hooks.yaml` … `<cwd>/.dsh/hooks.yaml`
 *      — project levels, discovered by walking up from the workspace cwd
 *        toward the git root (mirrors dsh-agent-instructions semantics),
 *        shallower dirs merge first so deeper dirs override.
 *
 * Arrays append across layers; scalars and objects deep-merge;
 * `inherit: false` at a project layer drops every lower layer entirely.
 *
 * @module dsh-guard-hooks/config
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

/** Baseline configuration every layer merges over. */
export function defaultConfig() {
	return {
		hooks: {
			PreToolUse: [],
			PostToolUse: [],
			UserPromptSubmit: [],
			Stop: [],
			PreCompact: [],
			SessionStart: []
		},
		rules: {
			deny: [],
			ask: [],
			warn: [],
			allow: []
		},
		formatOnSave: {
			enabled: true,
			reportErrors: true,
			timeoutMs: 30_000,
			rules: []
		},
		notify: {
			onStop: false,
			onApprovalWait: false,
			onIntercept: false,
			sound: false
		},
		audit: {
			enabled: true,
			path: path.join(dshHome(), "audit", "hooks.jsonl"),
			maxBytes: 20 * 1024 * 1024,
			redact: ["authorization", "*key*", "*token*", "*secret*", "*password*"]
		},
		webhook: {
			url: "",
			events: [],
			headers: {},
			timeoutMs: 5_000
		}
	};
}

/** Resolve the DSH home directory the same way the CLI does (`$DSH_HOME` wins). */
export function dshHome() {
	return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p) {
	if (typeof p !== "string") return p;
	if (p === "~") return os.homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * Find the nearest ancestor directory of `startDir` containing a `.git` entry
 * (the conventional repo root marker). Returns `null` when unrooted.
 */
export function findRepoRoot(startDir) {
	let current = path.resolve(startDir);
	for (;;) {
		try {
			if (fs.existsSync(path.join(current, ".git"))) return current;
		} catch {
			/* unreadable directory — keep walking */
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Project-level candidate paths from the repo root down to `cwd`, inclusive,
 * ordered shallow→deep so deeper directories override shallower ones.
 * Never looks above the repo root (or above `cwd` when unrooted).
 */
export function projectConfigPaths(cwd) {
	const absoluteCwd = path.resolve(cwd);
	const root = findRepoRoot(absoluteCwd) ?? absoluteCwd;
	const collected = [];
	let current = absoluteCwd;
	for (;;) {
		collected.push(path.join(current, ".dsh", "hooks.yaml"));
		if (current === root || path.dirname(current) === current) break;
		current = path.dirname(current);
	}
	return collected.reverse();
}

/**
 * Load and normalize the effective configuration for one workspace.
 *
 * @param {string} cwd - workspace cwd the session is rooted at.
 * @returns {{ config: object, sources: string[], warnings: string[], fatal: boolean }}
 */
export function loadConfig(cwd = process.cwd()) {
	const warnings = [];
	const layers = [];

	const userPath = path.join(dshHome(), "hooks.yaml");
	layers.push({ label: userPath, data: readYamlFile(userPath, warnings) });

	for (const projectPath of projectConfigPaths(cwd)) {
		const data = readYamlFile(projectPath, warnings);
		if (data !== undefined) layers.push({ label: projectPath, data });
	}

	let merged = defaultConfig();
	const sources = [];
	for (const layer of layers) {
		if (layer.data === undefined) continue;
		sources.push(layer.label);
		merged = mergeLayer(merged, layer.data);
	}

	const config = normalizeConfig(merged, warnings);
	return { config, sources, warnings, fatal: warnings.length > 0 };
}

/**
 * Cached config loader with **last-good** semantics.
 *
 * - Files are re-read only when size/mtime change (cheap stat per call).
 * - If a layer becomes unreadable/unparsable (typo, partial write, editor
 *   race), the previous successfully-merged snapshot stays active — a broken
 *   YAML must never silently disable deny rules. Warnings surface once per
 *   distinct problem via `onWarning`.
 *
 * @param {() => string} getCwd - workspace root provider.
 * @param {{ onWarning?: (message: string) => void }} [hooks]
 * @returns {{ get: () => object }}
 */
export function createConfigLoader(getCwd, { onWarning } = {}) {
	let cache = null; // { statKey, config }
	let lastGood = null; // last snapshot without fatal warnings
	const reportedWarnings = new Map(); // message -> last reported at ms

	const warnOnce = (message) => {
		if (!message) return;
		const now = Date.now();
		const lastAt = reportedWarnings.get(message) ?? 0;
		if (now - lastAt < 60_000) return;
		reportedWarnings.set(message, now);
		if (reportedWarnings.size > 200) reportedWarnings.clear();
		try {
			onWarning?.(message);
		} catch {
			/* never throw from logging */
		}
	};

	return {
		get() {
			const cwd = getCwd();
			const candidatePaths = [path.join(dshHome(), "hooks.yaml"), ...projectConfigPaths(cwd)];
			const stats = candidatePaths.map((filePath) => statOf(filePath));

			const statKey = `${cwd}\u0000${stats.map((entry) => (entry ? `${entry.mtimeMs}:${entry.size}` : "-")).join("|")}`;
			if (cache && cache.statKey === statKey) return cache.config;

			const { config, warnings } = loadConfig(cwd);
			if (warnings.length === 0) {
				lastGood = config;
				cache = { statKey, config };
				return config;
			}
			for (const warning of warnings) warnOnce(warning);
			// Keep protection alive: stick with the last known-good merge until
			// the files parse cleanly again (statKey is still updated so a later
			// fix re-validates immediately).
			const effective = lastGood ?? config;
			cache = { statKey, config: effective };
			return effective;
		}
	};
}

function statOf(filePath) {
	try {
		return fs.statSync(filePath);
	} catch {
		return null;
	}
}

/** Read one YAML file; missing file → `undefined`, broken file → warning + `undefined`. */
function readYamlFile(filePath, warnings) {
	let raw;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		warnings.push(`hooks: cannot read ${filePath}: ${error.message}`);
		return undefined;
	}
	try {
		const data = yaml.load(raw);
		if (data === undefined || data === null) return undefined;
		if (typeof data !== "object" || Array.isArray(data)) {
			warnings.push(`hooks: ${filePath} must be a YAML mapping, got ${typeof data}`);
			return undefined;
		}
		return data;
	} catch (error) {
		warnings.push(`hooks: cannot parse ${filePath}: ${error.message}`);
		return undefined;
	}
}

/** Deep-merge one layer into the accumulated config. */
function mergeLayer(base, layer) {
	if (layer.inherit === false) base = defaultConfig();
	const out = { ...base };
	for (const [key, value] of Object.entries(layer)) {
		if (key === "inherit") continue;
		out[key] = mergeValue(base[key], value, [key]);
	}
	return out;
}

/** Hook/rule list fields whose arrays append across layers instead of replacing. */
const APPEND_KEYS = new Set(["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "PreCompact", "SessionStart", "deny", "ask", "warn", "allow"]);

function mergeValue(baseValue, value, keyPath) {
	const leafKey = keyPath[keyPath.length - 1];
	const appends = Array.isArray(value) && (leafKey === "rules" && keyPath.includes("formatOnSave") || APPEND_KEYS.has(leafKey));
	if (Array.isArray(value)) {
		if (!appends) return value;
		const baseList = Array.isArray(baseValue) ? baseValue : [];
		return [...baseList, ...value];
	}
	if (value && typeof value === "object") {
		const baseObject = baseValue && typeof baseValue === "object" && !Array.isArray(baseValue) ? baseValue : {};
		const out = { ...baseObject };
		for (const [k, v] of Object.entries(value)) out[k] = mergeValue(baseObject[k], v, [...keyPath, k]);
		return out;
	}
	return value;
}

/**
 * Normalize the merged shape: coerce single objects into lists, fill defaults,
 * drop unknown event names. Collects problems instead of throwing.
 */
export function normalizeConfig(raw, warnings) {
	const config = defaultConfig();

	// hooks.<Event> entries
	const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "PreCompact", "SessionStart"];
	if (raw.hooks && typeof raw.hooks === "object") {
		for (const [event, entries] of Object.entries(raw.hooks)) {
			if (!HOOK_EVENTS.includes(event)) {
				warnings.push(`hooks: unknown event "${event}" (known: ${HOOK_EVENTS.join(", ")})`);
				continue;
			}
			const normalized = toArray(entries)
				.map((entry) => normalizeHookEntry(entry, event, warnings))
				.filter(Boolean);
			if (normalized.length > MAX_ENTRIES_PER_EVENT) {
				warnings.push(`hooks.${event}: ${normalized.length} entries exceeds the ${MAX_ENTRIES_PER_EVENT} cap; extra dropped`);
				normalized.length = MAX_ENTRIES_PER_EVENT;
			}
			config.hooks[event] = normalized;
		}
	}

	// rules
	if (raw.rules && typeof raw.rules === "object") {
		for (const kind of ["deny", "ask", "warn", "allow"]) {
			config.rules[kind] = toStringList(raw.rules[kind]).slice(0, 500);
		}
	}

	// formatOnSave
	if (raw.formatOnSave && typeof raw.formatOnSave === "object") {
		const f = raw.formatOnSave;
		if (typeof f.enabled === "boolean") config.formatOnSave.enabled = f.enabled;
		if (typeof f.reportErrors === "boolean") config.formatOnSave.reportErrors = f.reportErrors;
		config.formatOnSave.timeoutMs = clampTimeout(f.timeoutMs) ?? config.formatOnSave.timeoutMs;
		config.formatOnSave.rules = toArray(f.rules)
			.map((rule) => {
				if (!rule || typeof rule !== "object" || !rule.match || !rule.command) {
					warnings.push("formatOnSave: each rule needs `match` and `command`");
					return null;
				}
				return { match: String(rule.match), command: String(rule.command), timeoutMs: clampTimeout(rule.timeoutMs) ?? config.formatOnSave.timeoutMs };
			})
			.filter(Boolean)
			.slice(0, 50);
	}

	// notify
	if (raw.notify && typeof raw.notify === "object") {
		for (const key of ["onStop", "onApprovalWait", "onIntercept", "sound"]) {
			if (typeof raw.notify[key] === "boolean") config.notify[key] = raw.notify[key];
		}
	}

	// audit
	if (raw.audit && typeof raw.audit === "object") {
		const a = raw.audit;
		if (typeof a.enabled === "boolean") config.audit.enabled = a.enabled;
		if (typeof a.path === "string" && a.path.trim()) config.audit.path = expandHome(a.path.trim());
		if (Number.isFinite(a.maxBytes) && a.maxBytes >= 64) config.audit.maxBytes = Math.floor(a.maxBytes);
		if (a.redact !== undefined) config.audit.redact = toStringList(a.redact);
	}

	// webhook
	if (raw.webhook && typeof raw.webhook === "object") {
		const w = raw.webhook;
		if (typeof w.url === "string") config.webhook.url = w.url.trim();
		if (w.events !== undefined) config.webhook.events = toStringList(w.events);
		if (w.headers && typeof w.headers === "object" && !Array.isArray(w.headers)) {
			config.webhook.headers = Object.fromEntries(Object.entries(w.headers).map(([k, v]) => [String(k), String(v)]));
		}
		if (Number.isFinite(w.timeoutMs) && w.timeoutMs > 0) config.webhook.timeoutMs = w.timeoutMs;
	}

	return config;
}

/** Per-event hook entry cap — guards against pathological configs. */
const MAX_ENTRIES_PER_EVENT = 100;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 600_000;

function normalizeHookEntry(entry, event, warnings) {
	if (typeof entry === "string") {
		return { command: entry, matcher: undefined, timeoutMs: 10_000, async: false, shell: undefined };
	}
	if (!entry || typeof entry !== "object" || typeof entry.command !== "string" || !entry.command.trim()) {
		warnings.push(`hooks.${event}: entry needs a non-empty \`command\``);
		return null;
	}
	const shell =
		entry.shell === undefined || entry.shell === true
			? undefined
			: typeof entry.shell === "string" && entry.shell.trim() && entry.shell.length <= 260
				? entry.shell.trim()
				: false; // explicit false → spawn argv directly without a shell
	return {
		command: entry.command,
		matcher: typeof entry.matcher === "string" ? entry.matcher : undefined,
		timeoutMs: clampTimeout(entry.timeoutMs) ?? 10_000,
		async: entry.async === true,
		shell
	};
}

/** Clamp a user timeout into [100ms, 10min]; undefined passes through. */
export function clampTimeout(value) {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return undefined;
	return Math.min(Math.max(Math.floor(n), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function toStringList(value) {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) return value.map(String);
	if (typeof value === "string") return [value];
	return [];
}

function toArray(value) {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}
