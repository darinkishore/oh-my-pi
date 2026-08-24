import { type } from "arktype";
import type {
	ExtensionFactory,
	ExtensionsReloadOptions,
	ExtensionsReloadReport,
	ToolDefinition,
} from "./extensibility/extensions";

const commandToolSchema = type({
	name: type("string").describe('Command name without the leading "/"'),
	"args?": type("string").describe("Argument string passed to the command verbatim"),
});

const LEADING_SLASH = /^\/+|\/+$/g;
const WHITESPACE = /\s+/;

export function parseReloadArgs(args: string): ExtensionsReloadOptions {
	const options: ExtensionsReloadOptions = {};
	for (const token of args.trim().split(WHITESPACE)) {
		if (!token) {
			continue;
		}
		if (token === "force") {
			options.force = true;
			continue;
		}
		throw new Error(`Unknown reload option: ${token}. Expected "force" or no arguments.`);
	}
	return options;
}

export function formatExtensionsReloadReport(report: ExtensionsReloadReport): string {
	let headline = "Reload complete (model-visible tool schema changed; prompt cache invalidated).";
	if (report.aborted) {
		headline = "Reload ABORTED: fresh extension source failed to load; the previous graph remains live.";
	} else if (report.cacheClean) {
		headline = "Reload complete (model-visible prefix unchanged).";
	}
	const lines = [headline];
	const addList = (label: string, items: readonly string[]): void => {
		if (items.length > 0) {
			lines.push(`- ${label}: ${items.join(", ")}`);
		}
	};
	addList("refreshed", report.refreshed);
	addList("description frozen", report.descriptionFrozen);
	if (report.versioned.length > 0) {
		lines.push(
			`- versioned: ${report.versioned.map(({ name, versionedName }) => `${name} -> ${versionedName}`).join(", ")}`,
		);
	}
	addList("added (deferred)", report.added);
	addList("removed", report.removed);
	if (report.errors.length > 0) {
		lines.push(`- errors: ${report.errors.map(({ path, error }) => `${path}: ${error}`).join("; ")}`);
	}
	if (report.toolAnnouncements.length > 0) {
		lines.push("Deferred tools are callable by explicit name now and enter the model-visible schema next session:");
		for (const announcement of report.toolAnnouncements) {
			lines.push(
				`  ${announcement.name}: ${announcement.description} params=${JSON.stringify(announcement.params)}`,
			);
		}
	}
	return lines.join("\n");
}

function isReloadReport(value: unknown): value is ExtensionsReloadReport {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<ExtensionsReloadReport>;
	return (
		Array.isArray(candidate.refreshed) &&
		Array.isArray(candidate.descriptionFrozen) &&
		Array.isArray(candidate.versioned) &&
		Array.isArray(candidate.added) &&
		Array.isArray(candidate.removed) &&
		typeof candidate.cacheClean === "boolean" &&
		Array.isArray(candidate.toolAnnouncements) &&
		Array.isArray(candidate.errors)
	);
}

function reloadUiMessage(report: ExtensionsReloadReport): string {
	if (report.aborted) {
		return "Extension reload aborted; the previous graph remains live.";
	}
	if (report.cacheClean) {
		return "Extensions reloaded without changing the model-visible prefix.";
	}
	return "Extensions reloaded; model-visible tool schema changed.";
}

function formatCommandResult(name: string, result: unknown): string {
	if (isReloadReport(result)) {
		return formatExtensionsReloadReport(result);
	}
	if (typeof result === "string" && result.length > 0) {
		return result;
	}
	return `Command /${name} completed.`;
}

export const createCommandBridgeExtension: ExtensionFactory = api => {
	api.registerCommand("reload-extensions", {
		description: 'Hot-reload extension source. Optional argument: "force"',
		modelInvocable: true,
		handler: async (args, ctx) => {
			const report = await ctx.reloadExtensions(parseReloadArgs(args));
			if (ctx.hasUI) {
				let level: "error" | "info" | "warning" = "info";
				if (report.aborted) {
					level = "error";
				} else if (report.errors.length > 0) {
					level = "warning";
				}
				ctx.ui.notify(reloadUiMessage(report), level);
			}
			return report;
		},
	});

	const commandTool: ToolDefinition<typeof commandToolSchema> = {
		name: "command",
		label: "Command",
		loadMode: "essential",
		description:
			"Invoke a model-invocable slash command by name. Use reload-extensions after editing extension source files.",
		parameters: commandToolSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const name = params.name.trim().replace(LEADING_SLASH, "");
			const invocable = ctx.getInvocableCommands();
			if (!invocable.some(command => command.name === name)) {
				const available = invocable.map(command => `/${command.name}`).join(", ") || "(none)";
				return {
					content: [
						{
							type: "text",
							text: `Unknown or non-model-invocable command: /${name}. Available: ${available}`,
						},
					],
					isError: true,
				};
			}
			try {
				const result = await ctx.invokeCommand(name, params.args ?? "");
				const text = formatCommandResult(name, result);
				return { content: [{ type: "text", text }] };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Command /${name} failed: ${message}` }],
					isError: true,
				};
			}
		},
	};
	api.registerTool(commandTool);
};
