import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, discoverAuthStorage, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const evalProbeExtension: ExtensionFactory = pi => {
	pi.registerTool({
		name: "eval_probe",
		label: "Eval Probe",
		description: "Exercise the session-bound extension eval API.",
		parameters: type({}),
		loadMode: "essential",
		async execute(_toolCallId, _params, signal, onUpdate, ctx) {
			return await ctx.runEval(
				{
					language: "js",
					code: `
globalThis.__extensionEvalProbe = (globalThis.__extensionEvalProbe ?? 0) + 1;
const replies = await parallel([
  () => tool.echo({ value: "left" }),
  () => tool.echo({ value: "right" })
]);
display({ counter: globalThis.__extensionEvalProbe, replies });`,
				},
				{
					sessionId: "extension-eval-probe",
					signal,
					onUpdate,
					resolveTool: name =>
						name === "echo"
							? {
									name,
									async execute(_id, args) {
										if (
											!args ||
											typeof args !== "object" ||
											!("value" in args) ||
											typeof args.value !== "string"
										) {
											throw new Error("echo requires a string value");
										}
										return {
											content: [
												{
													type: "text",
													text: args.value,
												},
											],
										};
									},
								}
							: undefined,
				},
			);
		},
	});
};

const jsonOutputsOf = (result: { details?: unknown }): unknown[] => {
	const details = result.details;
	if (!details || typeof details !== "object" || !("jsonOutputs" in details) || !Array.isArray(details.jsonOutputs)) {
		throw new Error("eval result omitted jsonOutputs");
	}
	return details.jsonOutputs;
};

describe("session-bound extension eval", () => {
	let tempDir: string;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-extension-eval-${Snowflake.next()}-`));
		modelRegistry = new ModelRegistry(await discoverAuthStorage(tempDir));
	});

	afterAll(() => {
		removeSyncWithRetries(tempDir);
	});

	it("uses the real persistent JS kernel while restricting nested tools", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "task.maxConcurrency": 2 }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [evalProbeExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: {
				rootPath: tempDir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});
		try {
			const probe = session.getToolByName("eval_probe");
			if (!probe) throw new Error("eval probe tool was not registered");
			const first = await probe.execute("probe-1", {});
			const second = await probe.execute("probe-2", {});
			const firstOutputs = jsonOutputsOf(first);
			const secondOutputs = jsonOutputsOf(second);

			expect(firstOutputs).toEqual([{ counter: 1, replies: ["left", "right"] }]);
			expect(secondOutputs).toEqual([{ counter: 2, replies: ["left", "right"] }]);
		} finally {
			await session.dispose();
		}
	});
});
