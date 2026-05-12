#!/usr/bin/env -S node --preserve-symlinks --preserve-symlinks-main

import puppeteer from "puppeteer-core";

const presets = {
	desktop: { deviceScaleFactor: 1, height: 900, mobile: false, width: 1440 },
	mobile: { deviceScaleFactor: 2, height: 812, mobile: true, width: 375 },
	tablet: { deviceScaleFactor: 2, height: 1024, mobile: true, width: 768 },
};

const arg = process.argv[2];

if (!arg || arg === "--help") {
	console.log("Usage: browser-viewport.js <preset | WIDTHxHEIGHT | reset>");
	console.log("\nPresets:");
	console.log("  desktop  1440×900");
	console.log("  mobile   375×812 (iPhone, 2x)");
	console.log("  reset    Clear override, use actual window size");
	console.log("  tablet   768×1024 (iPad, 2x)");
	console.log("\nCustom:");
	console.log("  browser-viewport.js 1280x720");
	process.exit(1);
}

const browser = await puppeteer.connect({
	browserURL: "http://localhost:9222",
	defaultViewport: null,
});

const page = (await browser.pages()).at(-1);
const client = await page.createCDPSession();

if (arg === "reset") {
	await client.send("Emulation.clearDeviceMetricsOverride");
	const { windowId } = await client.send("Browser.getWindowForTarget");
	const { bounds } = await client.send("Browser.getWindowBounds", { windowId });
	await client.send("Emulation.setDeviceMetricsOverride", {
		deviceScaleFactor: 0, // 0 = use default
		height: 0, // 0 = use window height
		mobile: false,
		width: 0, // 0 = use window width
	});
	await client.send("Emulation.clearDeviceMetricsOverride");
	await browser.disconnect();
	console.log(`✓ Viewport reset to window size (${bounds.width}×${bounds.height})`);
	process.exit(0);
}

let viewport;

if (presets[arg]) {
	viewport = presets[arg];
} else {
	const match = arg.match(/^(\d+)x(\d+)$/);

	if (!match) {
		console.error(`✗ Invalid viewport: ${arg}`);
		console.error("  Use a preset (desktop, mobile, tablet, reset) or WIDTHxHEIGHT");
		process.exit(1);
	}

	viewport = {
		deviceScaleFactor: 1,
		height: Number.parseInt(match[2]),
		mobile: false,
		width: Number.parseInt(match[1]),
	};
}

await client.send("Emulation.setDeviceMetricsOverride", viewport);
await browser.disconnect();

console.log(`✓ Viewport set to ${viewport.width}×${viewport.height}${viewport.mobile ? " (mobile)" : ""}`);
