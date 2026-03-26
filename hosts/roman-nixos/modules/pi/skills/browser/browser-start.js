#!/usr/bin/env -S node --preserve-symlinks --preserve-symlinks-main

import { spawn, execSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const profileName = process.argv[2] || "Agent";

if (process.argv[2] === "--help") {
	console.log("Usage: browser-start.js [profile]");
	console.log("\nArguments:");
	console.log("  profile  Profile name to use (default: Agent)");
	process.exit(1);
}

const BASE_DIR = `${process.env.HOME}/.cache/browser-skill`;
const PROFILE_DIR = `${BASE_DIR}/${profileName}`;

// Check if already running on :9222
try {
	const browser = await puppeteer.connect({
		browserURL: "http://localhost:9222",
		defaultViewport: null,
	});
	await browser.disconnect();
	console.log("✓ Chrome already running on :9222");
	process.exit(0);
} catch {}

// Setup profile directory
execSync(`mkdir -p "${PROFILE_DIR}"`, { stdio: "ignore" });

// Remove SingletonLock to allow new instance
try {
	execSync(`rm -f "${BASE_DIR}/SingletonLock" "${BASE_DIR}/SingletonSocket" "${BASE_DIR}/SingletonCookie"`, { stdio: "ignore" });
} catch {}

// Detect Chromium-based browser
const chromePath = (() => {
	const candidates = [
		"brave",
		"brave-browser",
		"google-chrome-stable",
		"google-chrome",
		"chromium-browser",
		"chromium",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	];
	for (const c of candidates) {
		try {
			execSync(`which "${c}"`, { stdio: "ignore" });
			return c;
		} catch {}
	}
	throw new Error("No Chromium-based browser found");
})();

// Start Chrome with flags to force new instance
spawn(
	chromePath,
	[
		"--remote-debugging-port=9222",
		`--user-data-dir=${BASE_DIR}`,
		`--profile-directory=${profileName}`,
		"--no-first-run",
		"--no-default-browser-check",
	],
	{ detached: true, stdio: "ignore" },
).unref();

// Wait for Chrome to be ready
let connected = false;
for (let i = 0; i < 30; i++) {
	try {
		const browser = await puppeteer.connect({
			browserURL: "http://localhost:9222",
			defaultViewport: null,
		});
		await browser.disconnect();
		connected = true;
		break;
	} catch {
		await new Promise((r) => setTimeout(r, 500));
	}
}

if (!connected) {
	console.error("✗ Failed to connect to Chrome");
	process.exit(1);
}

console.log(`✓ Chrome started on :9222 with profile "${profileName}"`);
