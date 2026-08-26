/**
 * Pattern matching for hook matchers and rule patterns.
 *
 * Two syntaxes:
 * - `/regex/i` or `/regex/`: a leading slash + trailing slash wraps a regex;
 *   trailing `i` enables case-insensitive matching.
 * - otherwise: shell-style wildcard where `*` matches any run of characters
 *   (including spaces and slashes) and `?` matches one character —
 *   deliberately NOT path-glob semantics, so `rm -rf /*` matches `rm -rf /`.
 *
 * File-extension matching (`matchGlobList`) keeps real glob semantics, matched
 * case-insensitively (Windows-style).
 *
 * All compilers cache their results and report invalid user patterns exactly
 * once via {@link onBrokenPattern} instead of spamming on every event.
 *
 * @module dsh-guard-hooks/patterns
 */

import picomatch from "picomatch";

/** Compiled-pattern cache: the same config patterns repeat on every event. */
const patternCache = new Map();
/** Tool-matcher cache. */
const toolMatcherCache = new Map();
/** Patterns whose regex failed to compile — warned once, match nothing. */
const brokenPatterns = new Set();

let brokenPatternListener = null;

/** Register a logger for invalid user patterns (replays already-broken ones). */
export function onBrokenPattern(listener) {
	brokenPatternListener = listener;
	for (const text of brokenPatterns) {
		try {
			listener?.(text);
		} catch {
			/* logging must not throw */
		}
	}
}

function warnBrokenPattern(text) {
	if (!brokenPatterns.has(text)) {
		brokenPatterns.add(text);
		try {
			brokenPatternListener?.(`hooks: 无效的匹配模式 "${text}"（该规则永远不命中，请检查 YAML）`);
		} catch {
			/* ignore */
		}
	}
}

/**
 * Parse one user pattern into a predicate.
 *
 * @param {string} pattern
 * @returns {(value: string) => boolean}
 */
export function compilePattern(pattern) {
	const text = String(pattern ?? "");
	const cached = patternCache.get(text);
	if (cached) return cached;

	let predicate;
	if (isRegexForm(text)) {
		const lastSlash = text.lastIndexOf("/");
		predicate = buildPredicate(text.slice(1, lastSlash), text.slice(lastSlash + 1), text);
	} else {
		predicate = buildPredicate(wildcardToRegexSource(text), "", text);
	}

	if (patternCache.size > 2000) patternCache.clear();
	patternCache.set(text, predicate);
	return predicate;
}

function isRegexForm(text) {
	return text.length >= 2 && text.startsWith("/") && /^\/[a-z]*$/i.test(text.slice(text.lastIndexOf("/")));
}

function buildPredicate(source, flags, originalText) {
	try {
		const regex = new RegExp(source, flags);
		return (value) => regex.test(value);
	} catch {
		warnBrokenPattern(originalText);
		return () => false;
	}
}

/** Translate a `*`/`?` wildcard pattern into an anchored regex source. */
export function wildcardToRegexSource(pattern) {
	let out = "^";
	for (const char of String(pattern)) {
		if (char === "*") out += "[\\s\\S]*";
		else if (char === "?") out += "[\\s\\S]";
		else out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return `${out}$`;
}

/** Compile a list of patterns into one "any" predicate. */
export function compileAny(patterns) {
	const compiled = (patterns ?? []).map(compilePattern);
	return (value) => compiled.some((match) => match(value));
}

/**
 * Compile a tool-name `matcher` — a plain regex source string
 * (`"Bash|Pwsh"`, `"StrReplaceEditor|Fs|Edit"`). Matching is
 * case-insensitive: real registries expose both `Pwsh` and `pwsh`. Invalid
 * regexes are reported once and match nothing.
 *
 * @param {string|undefined} matcher
 * @returns {{ matches: (toolName: string) => boolean, error?: string }}
 */
export function compileToolMatcher(matcher) {
	if (!matcher) return { matches: () => true };
	const cacheKey = `i::${matcher}`;
	const cached = toolMatcherCache.get(cacheKey);
	if (cached) return cached;

	let result;
	try {
		const regex = new RegExp(matcher, "i");
		result = { matches: (name) => regex.test(name) };
	} catch (error) {
		result = { matches: () => false, error: String(error?.message ?? error) };
		warnBrokenPattern(`matcher:${matcher}`);
	}

	if (toolMatcherCache.size > 500) toolMatcherCache.clear();
	toolMatcherCache.set(cacheKey, result);
	return result;
}

/**
 * Match a glob list like `"*.ts, *.tsx, *.js"` against a path,
 * case-insensitively so `*.TS` configs behave sensibly on Windows.
 *
 * @param {string} commaList
 * @param {string} filePath
 */
export function matchGlobList(commaList, filePath) {
	const globs = String(commaList ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (globs.length === 0) return false;
	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	return globs.some(
		(glob) => picomatch.isMatch(base, glob, { dot: true, nocase: true }) || picomatch.isMatch(filePath, glob, { dot: true, nocase: true })
	);
}
