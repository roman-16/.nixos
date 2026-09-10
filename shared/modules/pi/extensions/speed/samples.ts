import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const FALLBACK_CHARS_PER_TOKEN = 4;
const FILE_SUFFIX = ".jsonl";
const STORAGE_DIR = "speed";

export const CALIBRATION_DAYS = 3;
export const DAY = 24 * 60 * 60 * 1000;
export const RETENTION_DAYS = 90;

export type Kind = "thinking" | "visible";

export interface Sample {
	at: number;
	firstTokenMs: number;
	model: string;
	outputTokens: number;
	project: string;
	reasoningTokens: number | null;
	session: string;
	sessionName: string | null;
	thinkingChars: number;
	thinkingMs: number;
	totalMs: number;
	visibleChars: number;
}

export function localDate(ms: number): string {
	const date = new Date(ms);
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

const storageDir = () => join(getAgentDir(), STORAGE_DIR);

function dayFiles(): string[] {
	try {
		return readdirSync(storageDir()).filter((file) => file.endsWith(FILE_SUFFIX));
	} catch {
		return [];
	}
}

export function readSamples(cutoff: number): Sample[] {
	const oldest = localDate(cutoff);
	const samples: Sample[] = [];

	for (const file of dayFiles()) {
		if (file.slice(0, -FILE_SUFFIX.length) < oldest) continue;

		let text: string;
		try {
			text = readFileSync(join(storageDir(), file), "utf8");
		} catch {
			continue;
		}

		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				const sample = JSON.parse(line) as Sample;
				if (
					typeof sample.at === "number" &&
					typeof sample.outputTokens === "number" &&
					sample.at >= cutoff
				) {
					samples.push(sample);
				}
			} catch {}
		}
	}

	return samples;
}

export function writeSample(sample: Sample): void {
	try {
		mkdirSync(storageDir(), { recursive: true });
		appendFileSync(
			join(storageDir(), `${localDate(sample.at)}${FILE_SUFFIX}`),
			`${JSON.stringify(sample)}\n`,
		);
	} catch {}
}

export function pruneSamples(): void {
	const oldest = localDate(Date.now() - RETENTION_DAYS * DAY);

	for (const file of dayFiles()) {
		if (file.slice(0, -FILE_SUFFIX.length) >= oldest) continue;
		try {
			unlinkSync(join(storageDir(), file));
		} catch {}
	}
}

function measured(sample: Sample, kind: Kind): { chars: number; tokens: number } {
	const reasoning = sample.reasoningTokens ?? 0;
	return kind === "thinking"
		? { chars: sample.thinkingChars, tokens: reasoning }
		: { chars: sample.visibleChars, tokens: sample.outputTokens - reasoning };
}

function charsPerToken(samples: Sample[], kind: Kind): number | undefined {
	let chars = 0;
	let tokens = 0;

	for (const sample of samples) {
		const sampled = measured(sample, kind);
		if (sampled.chars <= 0 || sampled.tokens <= 0) continue;
		chars += sampled.chars;
		tokens += sampled.tokens;
	}

	return chars > 0 && tokens > 0 ? chars / tokens : undefined;
}

export function calibrate(samples: Sample[], model: string | undefined, kind: Kind): number {
	const forModel = model
		? charsPerToken(
				samples.filter((sample) => sample.model === model),
				kind,
			)
		: undefined;

	return forModel ?? charsPerToken(samples, kind) ?? FALLBACK_CHARS_PER_TOKEN;
}

export function tokensPerSecond(tokens: number, ms: number): number {
	return ms > 0 ? (tokens * 1000) / ms : 0;
}
