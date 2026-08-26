/**
 * Fire-and-forget webhook delivery of hook events, with optional HMAC-SHA256
 * request signing (`X-DSH-Signature: sha256=<hex>` over the raw body) so
 * receivers can authenticate the source.
 *
 * @module dsh-guard-hooks/webhook
 */

import crypto from "node:crypto";

/**
 * Compute the signature header value for one body.
 *
 * @param {string} body - exact bytes that will be sent.
 * @param {string} secret - shared HMAC key.
 * @returns {string} `sha256=<hex>`
 */
export function signBody(body, secret) {
	return `sha256=${crypto.createHmac("sha256", String(secret)).update(body).digest("hex")}`;
}

/**
 * POST one event payload to the configured URL. Never throws; failures are
 * reported to `onError` for logging only.
 *
 * @param {object} webhookConfig - `{url, events, headers, timeoutMs, secret?}`.
 * @param {object} payload - JSON event payload.
 * @param {(error: unknown) => void} [onError]
 */
export function pushWebhook(webhookConfig, payload, onError) {
	const url = webhookConfig?.url;
	if (!url) return;
	if (Array.isArray(webhookConfig.events) && webhookConfig.events.length > 0) {
		if (!webhookConfig.events.includes(payload.event)) return;
	}
	const body = safeStringify(payload);
	const headers = { "content-type": "application/json", ...(webhookConfig.headers ?? {}) };
	if (webhookConfig.secret) {
		try {
			headers["x-dsh-signature"] = signBody(body, webhookConfig.secret);
		} catch {
			/* signing must never block delivery */
		}
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), webhookConfig.timeoutMs ?? 5_000);
	fetch(url, {
		method: "POST",
		headers,
		body,
		signal: controller.signal
	})
		.catch((error) => onError?.(error))
		.finally(() => clearTimeout(timer));
}

function safeStringify(value) {
	try {
		return JSON.stringify(value);
	} catch {
		return JSON.stringify({ event: value?.event, error: "[unserializable payload]" });
	}
}
