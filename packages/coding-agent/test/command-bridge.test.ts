import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildToolsMarkdown } from "@oh-my-pi/pi-coding-agent/modes/utils/tools-markdown";
import { createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus, ScopedEventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { formatExtensionsReloadReport, parseReloadArgs } from "../src/command-bridge";
import type { ExtensionsReloadReport } from "../src/extensibility/extensions";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const directory = join(tmpdir(), `${prefix}-${Snowflake.next()}`);
	tempDirs.push(directory);
	mkdirSync(directory, { recursive: true });
	return directory;
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		removeSyncWithRetries(directory);
	}
});

function makeReport(overrides: Partial<ExtensionsReloadReport>): ExtensionsReloadReport {
	return {
		refreshed: [],
		descriptionFrozen: [],
		versioned: [],
		added: [],
		removed: [],
		cacheClean: true,
		toolAnnouncements: [],
		errors: [],
		...overrides,
	};
}

async function readTextResult(tool: AgentTool | undefined): Promise<string> {
	if (!tool) {
		throw new Error("tool missing");
	}
	const result = await tool.execute("call-1", {}, undefined, undefined);
	const first = result.content[0];
	if (first?.type === "text") {
		return first.text;
	}
	throw new Error("unexpected tool result");
}

describe("native command bridge", () => {
	it("accepts only the documented reload argument", () => {
		expect(parseReloadArgs("")).toEqual({});
		expect(parseReloadArgs("force")).toEqual({ force: true });
		expect(() => parseReloadArgs("activate=probe")).toThrow("Unknown reload option");
	});

	it("formats cache-clean, invalidating, and aborted reports distinctly", () => {
		expect(formatExtensionsReloadReport(makeReport({ cacheClean: true }))).toStartWith(
			"Reload complete (model-visible prefix unchanged).",
		);
		expect(formatExtensionsReloadReport(makeReport({ cacheClean: false }))).toStartWith(
			"Reload complete (model-visible tool schema changed; prompt cache invalidated).",
		);
		expect(
			formatExtensionsReloadReport(
				makeReport({ aborted: true, errors: [{ path: "probe.ts", error: "syntax error" }] }),
			),
		).toContain("the previous graph remains live");
	});
});

describe("ScopedEventBus", () => {
	it("keeps staged subscriptions dormant, then disposes them", () => {
		const shared = new EventBus();
		const disposers: Array<() => void> = [];
		const scoped = new ScopedEventBus(shared, disposers, false);
		const deliveries: unknown[] = [];
		scoped.on("probe", value => deliveries.push(value));

		shared.emit("probe", "before-activation");
		expect(deliveries).toEqual([]);
		scoped.activate();
		shared.emit("probe", "active");
		expect(deliveries).toEqual(["active"]);
		scoped.clear();
		shared.emit("probe", "after-disposal");
		expect(deliveries).toEqual(["active"]);
	});
});

describe("command tool extension reload", () => {
	let modelRegistry: ModelRegistry;
	let authDirectory: string;

	beforeAll(async () => {
		authDirectory = join(tmpdir(), `omp-command-bridge-auth-${Snowflake.next()}`);
		mkdirSync(authDirectory, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(authDirectory));
	});

	afterAll(() => {
		removeSyncWithRetries(authDirectory);
	});

	async function createProbeSession(options?: { secondExtension?: string; parametersSource?: string }): Promise<{
		session: AgentSession;
		entryPath: string;
		valuePath: string;
	}> {
		const tempDirectory = makeTempDir("omp-command-bridge-e2e");
		const extensionDirectory = join(tempDirectory, "ext");
		mkdirSync(extensionDirectory, { recursive: true });
		const valuePath = join(extensionDirectory, "probe-value.ts");
		const entryPath = join(extensionDirectory, "probe.ts");
		writeFileSync(valuePath, 'export const PROBE_VALUE = "probe-v1";\n');
		writeFileSync(
			entryPath,
			[
				'import { PROBE_VALUE } from "./probe-value.ts";',
				"",
				"export default function probeExtension(api) {",
				"  api.registerTool({",
				'    name: "probe",',
				'    label: "probe",',
				'    description: "returns the probe value",',
				`    parameters: ${options?.parametersSource ?? '{ type: "object", properties: {} }'},`,
				"    async execute() {",
				'      return { content: [{ type: "text", text: PROBE_VALUE }] };',
				"    },",
				"  });",
				"}",
				"",
			].join("\n"),
		);
		const extensionPaths = [entryPath];
		if (options?.secondExtension) {
			extensionPaths.push(options.secondExtension);
		}
		const result = await createAgentSession({
			cwd: tempDirectory,
			agentDir: tempDirectory,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			preloadedExtensionPaths: extensionPaths,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: {
				rootPath: tempDirectory,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});
		return { session: result.session, entryPath, valuePath };
	}

	it("reloads an edited module without unmounting dynamic devices", async () => {
		const { session, valuePath } = await createProbeSession();
		try {
			const runner = session.extensionRunner;
			if (!runner) {
				throw new Error("extension runner missing");
			}
			const mcpTool = {
				name: "mcp__reload_probe__search",
				label: "reload-probe/search",
				description: "searches the reload probe",
				parameters: { type: "object" as const, properties: {} },
				mcpServerName: "reload-probe",
				mcpToolName: "search",
				execute: async () => ({ content: [{ type: "text" as const, text: "mcp-live" }] }),
			};
			const hostTool: AgentTool = {
				name: "host_reload_probe",
				label: "Host reload probe",
				description: "checks host tool liveness across extension reloads",
				parameters: { type: "object", properties: {} },
				loadMode: "discoverable",
				execute: async () => ({ content: [{ type: "text" as const, text: "host-live" }] }),
			};
			await session.refreshRpcHostTools([hostTool]);
			await session.refreshMCPTools([mcpTool]);
			const mountedBefore = session.getXdevToolEntries().map(entry => entry.name);
			expect(mountedBefore).toContain("probe");
			expect(mountedBefore).toContain(hostTool.name);
			expect(mountedBefore).toContain(mcpTool.name);
			const systemPromptBefore = session.systemPrompt;
			expect(runner.getCommand("reload-extensions")?.modelInvocable).toBe(true);
			expect(runner.createContext().getInvocableCommands()).toContainEqual({
				name: "reload-extensions",
				description: 'Hot-reload extension source. Optional argument: "force"',
			});
			expect(await readTextResult(session.getToolByName("probe"))).toBe("probe-v1");

			writeFileSync(valuePath, 'export const PROBE_VALUE = "probe-v2";\n');
			const command = session.getToolByName("command");
			if (!command) {
				throw new Error("command tool missing");
			}
			const result = await command.execute("call-1", { name: "/reload-extensions" }, undefined, undefined);
			expect(result.isError).not.toBe(true);
			expect(result.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("model-visible prefix unchanged"),
			});
			expect(session.getXdevToolEntries().map(entry => entry.name)).toEqual(expect.arrayContaining(mountedBefore));
			expect(session.systemPrompt).toEqual(systemPromptBefore);
			expect(await readTextResult(session.getToolByName("probe"))).toBe("probe-v2");
			const write = session.getToolByName("write");
			if (!write) {
				throw new Error("write tool missing");
			}
			const mcpResult = await write.execute(
				"call-mcp-after-reload",
				{ path: `xd://${mcpTool.name}`, content: "{}" },
				undefined,
				undefined,
			);
			expect(mcpResult.content[0]).toEqual({ type: "text", text: "mcp-live" });
			const hostResult = await write.execute(
				"call-host-after-reload",
				{ path: `xd://${hostTool.name}`, content: "{}" },
				undefined,
				undefined,
			);
			expect(hostResult.content[0]).toEqual({ type: "text", text: "host-live" });
		} finally {
			await session.dispose();
		}
	});

	it("does not retire an unchanged tool after wire-schema normalization", async () => {
		const { session } = await createProbeSession({
			parametersSource: '{ type: "object", properties: { extra: { type: "object", additionalProperties: {} } } }',
		});
		try {
			const runner = session.extensionRunner;
			if (!runner) {
				throw new Error("extension runner missing");
			}

			const report = await runner.createContext().reloadExtensions();
			expect(report.versioned).toEqual([]);
			expect(report.refreshed).toContain("probe");
			expect(session.getDeferredExtensionToolByName("probe_v2")).toBeUndefined();
			expect(await readTextResult(session.getToolByName("probe"))).toBe("probe-v1");
		} finally {
			await session.dispose();
		}
	});

	it("exposes only reload-deferred tools through the extra-tool resolver", async () => {
		const { session, entryPath, valuePath } = await createProbeSession();
		try {
			expect(session.getDeferredExtensionToolByName("command")).toBeUndefined();
			writeFileSync(
				entryPath,
				[
					'import { PROBE_VALUE } from "./probe-value.ts";',
					"",
					"export default function probeExtension(api) {",
					"  for (const name of ['probe', 'late_probe']) {",
					"    api.registerTool({",
					"      name,",
					"      label: name,",
					'      description: "probe value",',
					'      parameters: { type: "object", properties: {} },',
					"      async execute() {",
					'        return { content: [{ type: "text", text: name + ":" + PROBE_VALUE }] };',
					"      },",
					"    });",
					"  }",
					"}",
					"",
				].join("\n"),
			);
			writeFileSync(valuePath, 'export const PROBE_VALUE = "probe-v2";\n');
			const runner = session.extensionRunner;
			if (!runner) {
				throw new Error("extension runner missing");
			}
			const report = await runner.createContext().reloadExtensions();
			expect(report.added).toEqual(["late_probe"]);
			expect(session.getActiveToolNames()).not.toContain("late_probe");
			expect(session.getDeferredExtensionToolByName("late_probe")?.name).toBe("late_probe");
			expect(session.getDeferredExtensionToolByName("command")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("retires an incompatible tool closure and directs calls to its versioned replacement", async () => {
		const { session, entryPath } = await createProbeSession();
		try {
			await session.setActiveToolsByName(["probe"]);
			writeFileSync(
				entryPath,
				[
					'import { PROBE_VALUE } from "./probe-value.ts";',
					"",
					"export default function probeExtension(api) {",
					"  api.registerTool({",
					'    name: "probe",',
					'    label: "probe",',
					'    description: "returns the probe value",',
					'    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },',
					"    async execute() {",
					'      return { content: [{ type: "text", text: PROBE_VALUE }] };',
					"    },",
					"  });",
					"}",
					"",
				].join("\n"),
			);
			const runner = session.extensionRunner;
			if (!runner) {
				throw new Error("extension runner missing");
			}
			const report = await runner.createContext().reloadExtensions();
			expect(report.versioned).toEqual([{ name: "probe", versionedName: "probe_v2" }]);

			const retired = session.getToolByName("probe");
			if (!retired) {
				throw new Error("retired probe tool missing");
			}
			expect(Object.hasOwn(retired, "name")).toBe(true);
			expect(retired.name).toBe("probe");
			const toolsBeforeRendering = session.agent.state.tools;
			const firstRendering = buildToolsMarkdown({ tools: toolsBeforeRendering });
			const secondRendering = buildToolsMarkdown({ tools: toolsBeforeRendering });
			expect(secondRendering).toBe(firstRendering);
			expect(firstRendering).toContain("`probe`");
			expect(session.agent.state.tools.find(tool => tool.name === "probe")?.name).toBe("probe");
			const retiredResult = await retired.execute("retired-probe", {}, undefined, undefined);
			expect(retiredResult.isError).toBe(true);
			expect(retiredResult.content[0]).toEqual({
				type: "text",
				text: 'Tool "probe" changed schema during extension reload and was retired. Retry with "probe_v2".',
			});
			expect(await readTextResult(session.getDeferredExtensionToolByName("probe_v2"))).toBe("probe-v1");
		} finally {
			await session.dispose();
		}
	});

	it("keeps the previous graph live and drops staged listeners after a failed reload", async () => {
		const tempDirectory = makeTempDir("omp-command-bridge-abort");
		const failingPath = join(tempDirectory, "failing.ts");
		writeFileSync(failingPath, "export default function validExtension() {}\n");
		const { session, entryPath } = await createProbeSession({ secondExtension: failingPath });
		try {
			const counterName = `__ompReloadCounter${Snowflake.next()}`;
			writeFileSync(
				entryPath,
				[
					`globalThis.${counterName} ??= 0;`,
					"export default function probeExtension(api) {",
					'  api.events.on("probe-ping", () => {',
					`    globalThis.${counterName} += 1;`,
					"  });",
					'  api.registerCommand("emit-probe-ping", {',
					"    async handler() {",
					'      api.events.emit("probe-ping", undefined);',
					"    },",
					"  });",
					"}",
					"",
				].join("\n"),
			);
			const runner = session.extensionRunner;
			if (!runner) {
				throw new Error("extension runner missing");
			}
			const firstReload = await runner.createContext().reloadExtensions();
			expect(firstReload.errors).toEqual([]);
			await runner.createContext().invokeCommand("emit-probe-ping");
			expect((globalThis as Record<string, unknown>)[counterName]).toBe(1);

			writeFileSync(failingPath, "export default function broken( {\n");
			const aborted = await runner.createContext().reloadExtensions();
			expect(aborted.aborted).toBe(true);
			expect(aborted.errors.length).toBeGreaterThan(0);
			await runner.createContext().invokeCommand("emit-probe-ping");
			expect((globalThis as Record<string, unknown>)[counterName]).toBe(2);
		} finally {
			await session.dispose();
		}
	});

	it("serializes concurrent reload requests", async () => {
		const { session, valuePath } = await createProbeSession();
		try {
			writeFileSync(valuePath, 'export const PROBE_VALUE = "probe-concurrent";\n');
			const runner = session.extensionRunner;
			if (!runner) {
				throw new Error("extension runner missing");
			}
			const context = runner.createContext();
			const reports = await Promise.all([context.reloadExtensions(), context.reloadExtensions()]);
			expect(reports.every(report => report.errors.length === 0)).toBe(true);
			expect(await readTextResult(session.getToolByName("probe"))).toBe("probe-concurrent");
		} finally {
			await session.dispose();
		}
	});
});
