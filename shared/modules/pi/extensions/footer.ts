import {
	FooterComponent,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MIN_GAP = 2;
const RIGHT_STATUS_KEYS = new Set(["speed"]);

interface Split {
	left: string;
	right: string;
}

function subscriptionBacked(ctx: ExtensionContext, provider: string): boolean {
	const model = ctx.model;
	if (!model || model.provider !== provider) return false;

	return (
		ctx.modelRegistry.isUsingOAuth(model) &&
		ctx.modelRegistry.getProvider(provider)?.auth.oauth?.isSubscription === true
	);
}

function sessionView(ctx: ExtensionContext): AgentSession {
	return {
		getContextUsage: () => ctx.getContextUsage(),
		get modelRuntime() {
			return { isUsingSubscription: (provider: string) => subscriptionBacked(ctx, provider) };
		},
		get sessionManager() {
			return ctx.sessionManager;
		},
		get state() {
			return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
		},
	} as unknown as AgentSession;
}

function withoutStatuses(footerData: ReadonlyFooterDataProvider): ReadonlyFooterDataProvider {
	return {
		getAvailableProviderCount: () => footerData.getAvailableProviderCount(),
		getExtensionStatuses: () => new Map<string, string>(),
		getGitBranch: () => footerData.getGitBranch(),
		onBranchChange: (callback: () => void) => footerData.onBranchChange(callback),
	};
}

function statusTexts(statuses: ReadonlyMap<string, string>): Split {
	const sorted = Array.from(statuses).sort(([left], [right]) => left.localeCompare(right));
	const join = (rightAligned: boolean) =>
		sorted
			.filter(([key]) => RIGHT_STATUS_KEYS.has(key) === rightAligned)
			.map(([, text]) =>
				text
					.replace(/[\r\n\t]/g, " ")
					.replace(/ {2,}/g, " ")
					.trim(),
			)
			.filter((text) => text !== "")
			.join(" ");

	return { left: join(false), right: join(true) };
}

function spread(left: string, right: string, width: number, ellipsis: string): Split {
	const fitted = visibleWidth(left) > width ? truncateToWidth(left, width, ellipsis) : left;
	const room = width - visibleWidth(fitted);
	if (right === "" || room <= MIN_GAP) return { left: fitted, right: "" };

	const shown = visibleWidth(right) + MIN_GAP <= room ? right : truncateToWidth(right, room - MIN_GAP, "");
	const shownWidth = visibleWidth(shown);

	return shownWidth === 0
		? { left: fitted, right: "" }
		: { left: fitted, right: `${" ".repeat(room - shownWidth)}${shown}` };
}

function statusLines(footerData: ReadonlyFooterDataProvider, theme: Theme, width: number): string[] {
	const statuses = statusTexts(footerData.getExtensionStatuses());
	if (statuses.left === "" && statuses.right === "") return [];

	const line = spread(statuses.left, statuses.right, width, theme.fg("dim", "..."));
	return [line.left + line.right];
}

export default function footer(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const autoCompact = SettingsManager.create(ctx.cwd, undefined, {
			projectTrusted: ctx.isProjectTrusted(),
		}).getCompactionEnabled();

		ctx.ui.setFooter((_tui, theme, footerData) => {
			let stats: FooterComponent | undefined;
			let broken = false;

			return {
				dispose: () => stats?.dispose(),
				invalidate: () => stats?.invalidate(),

				render(width: number): string[] {
					if (broken) return [];

					try {
						if (!stats) {
							stats = new FooterComponent(sessionView(ctx), withoutStatuses(footerData));
							stats.setAutoCompactEnabled(autoCompact);
						}
						return [...stats.render(width), ...statusLines(footerData, theme, width)];
					} catch (error) {
						broken = true;
						setTimeout(() => {
							ctx.ui.setFooter(undefined);
							ctx.ui.notify(
								`Status alignment disabled: ${error instanceof Error ? error.message : String(error)}`,
								"error",
							);
						}, 0);
						return [];
					}
				},
			};
		});
	});
}
