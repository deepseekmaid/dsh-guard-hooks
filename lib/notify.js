/**
 * Desktop notifications on Windows via a zero-dependency PowerShell balloon
 * tip (rendered as a toast on Windows 10/11). Other platforms degrade to a
 * terminal bell no-op.
 *
 * @module dsh-guard-hooks/notify
 */

import { spawn } from "node:child_process";

/** Cooldown so identical notifications cannot stack-spam within 3s. */
let lastAt = 0;
let lastKey = "";
/** Global storm guard: at most one toast per 1.5s regardless of content. */
const MIN_GLOBAL_INTERVAL_MS = 1_500;

/**
 * Show a desktop notification.
 *
 * @param {string} title
 * @param {string} body
 * @param {{sound?: boolean}} [options]
 */
export function notifyDesktop(title, body, options = {}) {
	const key = `${title}\u0000${body}`;
	const now = Date.now();
	if (now - lastAt < MIN_GLOBAL_INTERVAL_MS) return;
	if (key === lastKey && now - lastAt < 3_000) return;
	lastAt = now;
	lastKey = key;

	if (process.platform !== "win32") return;

	const script = [
		"Add-Type -AssemblyName System.Windows.Forms;",
		"Add-Type -AssemblyName System.Drawing;",
		"$n = [System.Windows.Forms.NotifyIcon]::new();",
		"$n.Icon = [System.Drawing.SystemIcons]::Information;",
		"$n.Visible = $true;",
		"$n.BalloonTipTitle = " + psString(title) + ";",
		"$n.BalloonTipText = " + psString(body) + ";",
		options.sound ? "$n.BalloonTipIcon = 'Info';" : "",
		"$n.ShowBalloonTip(5000);",
		"Start-Sleep -Seconds 6;",
		"$n.Dispose();"
	].filter(Boolean).join(" ");

	try {
		const encoded = Buffer.from(script, "utf16le").toString("base64");
		const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
			windowsHide: true,
			detached: true,
			stdio: "ignore"
		});
		child.on("error", () => {});
		child.unref?.();
	} catch {
		/* notification is best-effort */
	}
}

/** Single-quoted PowerShell string literal with doubled inner quotes. */
function psString(value) {
	return `'${String(value ?? "").replace(/'/g, "''").slice(0, 240)}'`;
}
