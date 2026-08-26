/**
 * Structured audit logging: one JSON line per recorded event.
 *
 * Never throws — auditing must not be able to break a session. Sensitive
 * values are redacted by glob patterns against key names.
 *
 * @module dsh-guard-hooks/audit
 */

import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";

/**
 * Append one record to the configured JSONL file, rotating to `<path>.1`
 * when the file exceeds `maxBytes` (single backup, oldest dropped).
 *
 * @param {object} auditConfig - `{enabled, path, redact, maxBytes?}`.
 * @param {object} record - plain JSON-serializable event record.
 */
export function auditRecord(auditConfig, record) {
	try {
		if (!auditConfig?.enabled || !auditConfig.path) return;
		fs.mkdirSync(path.dirname(auditConfig.path), { recursive: true });
		rotateIfNeeded(auditConfig);
		const clean = redact(record, auditConfig.redact);
		fs.appendFileSync(auditConfig.path, `${JSON.stringify(clean)}\n`, "utf8");
	} catch {
		/* auditing is best-effort by design */
	}
}

/** Roll `path` → `path.1` once it crosses the configured size budget. */
function rotateIfNeeded(auditConfig) {
	try {
		const maxBytes = Number.isFinite(auditConfig.maxBytes) ? auditConfig.maxBytes : 20 * 1024 * 1024;
		if (maxBytes <= 0) return;
		const { size } = fs.statSync(auditConfig.path);
		if (size < maxBytes) return;
		try {
			fs.rmSync(`${auditConfig.path}.1`, { force: true });
		} catch {
			/* no previous backup */
		}
		fs.renameSync(auditConfig.path, `${auditConfig.path}.1`);
	} catch {
		/* missing file is the normal case */
	}
}

/** Redact values whose keys match any of the glob patterns (case-insensitive). */
export function redact(value, patterns, key = "") {
	const compiled = (redact._compiled ??= new Map());
	if (!Array.isArray(patterns) || patterns.length === 0) return value;

	let predicates = compiled.get(patterns.join("\u0000"));
	if (!predicates) {
		predicates = patterns.map((pattern) => picomatch(String(pattern), { dot: true, nocase: true }));
		compiled.set(patterns.join("\u0000"), predicates);
	}

	const hit = key !== "" && predicates.some((isMatch) => isMatch(key));
	if (hit) return "[redacted]";
	if (Array.isArray(value)) return value.map((item) => redact(item, patterns));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, patterns, k)]));
	}
	return value;
}

/** Convenience wrappers for the record kinds this plugin emits. */

export function recordToolCall(auditConfig, data) {
	auditRecord(auditConfig, { kind: "tool-call", time: now(), ...data });
}

export function recordHookRun(auditConfig, data) {
	auditRecord(auditConfig, { kind: "hook-run", time: now(), ...data });
}

export function recordInterception(auditConfig, data) {
	auditRecord(auditConfig, { kind: "interception", time: now(), ...data });
}

function now() {
	return new Date().toISOString();
}
