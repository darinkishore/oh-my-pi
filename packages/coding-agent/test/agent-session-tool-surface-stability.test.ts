import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	dispatchXdevTool,
	setXdevMountedNames,
	type XdevState,
	xdevDocsAll,
} from "@oh-my-pi/pi-coding-agent/tools/xdev";

// Deterministic tool-surface invariant: the bytes of the wire tools array and
// the system prompt must not depend on WHEN a device mounts or unmounts. Live
// failure 2026-07-24: an extension reshaping the mount set at session_start
// (and MCP reconnects) removed device docs from the next system-prompt rebuild
// and flipped the write transport at the 0↔1 mount boundary — each one a full
// provider prompt-cache invalidation (~$4.2/rewrite at 370k context).

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function createBasicTool(name: string, label: string, description = `${label} tool`): AgentTool {
	return {
		name,
		label,
		description,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function createMcpCustomTool(name: string, serverName: string, mcpToolName: string, description: string): CustomTool {
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description,
		parameters: type({ q: "string" }),
		strict: true,
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as CustomTool;
}

function createXdevState(tools: AgentTool[] = []): XdevState {
	const toolMap = new Map(tools.map(tool => [tool.name, tool]));
	return {
		tools: toolMap,
		mountedNames: new Set(toolMap.keys()),
		catalog: new Map(toolMap),
		builtInNames: new Set(toolMap.keys()),
		isActive: () => false,
	};
}

/** Rendered xd:// mount notices within one provider call's messages. */
function mountNoticesIn(messages: Message[]): string[] {
	return messages.flatMap(message => {
		const { content } = message;
		const text =
			typeof content === "string"
				? content
				: content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
		return text.includes("The xd:// device inventory changed.") ? [text] : [];
	});
}

describe("AgentSession deterministic tool surface", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	function newSession(
		rebuildSystemPrompt: (toolNames: string[]) => Promise<string>,
		options: {
			xdev: XdevState;
			getLocalCalendarDate?: () => string;
			responses?: MockResponseSource;
		},
	): {
		session: AgentSession;
		contexts: Message[][];
		wireToolNames: () => string[];
	} {
		const readTool = createBasicTool("read", "Read");
		const writeTool = createBasicTool("write", "Write");
		const toolRegistry = options.xdev.tools;
		toolRegistry.set(readTool.name, readTool);
		toolRegistry.set(writeTool.name, writeTool);
		options.xdev.builtInNames.add(readTool.name);
		options.xdev.builtInNames.add(writeTool.name);
		const mock = options.responses ? createMockModel({ responses: options.responses }) : undefined;
		const contexts: Message[][] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, writeTool],
				messages: [],
			},
			convertToLlm,
			streamFn: mock
				? (model, context, streamOptions) => {
						contexts.push([...context.messages]);
						return mock.stream(model, context, streamOptions);
					}
				: undefined,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			toolRegistry,
			builtInToolNames: ["read", "write"],
			ensureWriteRegistered: async () => true,
			rebuildSystemPrompt: async (toolNames, _tools) => ({
				systemPrompt: [await rebuildSystemPrompt(toolNames)],
			}),
			getLocalCalendarDate: options.getLocalCalendarDate,
			xdev: options.xdev,
		});
		sessions.push(session);
		return {
			session,
			contexts,
			wireToolNames: () => agent.state.tools.map(tool => tool.name),
		};
	}

	it("keeps unmounted device docs in the system prompt across an unrelated rebuild", async () => {
		// The Route B failure: unmount fires no rebuild (by design), but the next
		// rebuild triggered for ANY other reason used to render docs from the
		// live mount set, silently dropping the unmounted device's docs and
		// re-keying the cached prefix. Docs must come from the sticky catalog.
		const xdev = createXdevState();
		let date = "2026-07-24";
		let rebuildCount = 0;
		let lastPrompt = "";
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				lastPrompt = `tools:${toolNames.join(",")}|docs:${xdevDocsAll(xdev)}`;
				return lastPrompt;
			},
			{ xdev, getLocalCalendarDate: () => date },
		);
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const fetch = createMcpCustomTool("mcp__nucleus_fetch", "nucleus", "fetch", "Fetch nucleus");

		await session.refreshMCPTools([search, fetch]);
		expect(rebuildCount).toBe(1);
		expect(lastPrompt).toContain("mcp__nucleus_search");
		expect(lastPrompt).toContain("mcp__nucleus_fetch");

		// Unmount fetch: canonical MCP route guidance triggers a rebuild, but the
		// sticky prompt catalog must retain the now-unmounted device docs.
		await session.refreshMCPTools([search]);
		expect(rebuildCount).toBe(2);
		expect(lastPrompt).toContain("mcp__nucleus_fetch");

		// An unrelated rebuild trigger (calendar rollover) must NOT swallow the
		// inventory delta: fetch stays documented even though it is unmounted.
		date = "2026-07-25";
		await session.refreshMCPTools([search]);
		expect(rebuildCount).toBe(3);
		expect(lastPrompt).toContain("mcp__nucleus_search");
		expect(lastPrompt).toContain("mcp__nucleus_fetch");
	});

	it("keeps the wire tools array byte-stable across a 1→0→1 mount cycle", async () => {
		const xdev = createXdevState();
		const { session, wireToolNames } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdev,
		});
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");

		await session.refreshMCPTools([search]);
		const mountedNames = wireToolNames();
		expect(mountedNames).toContain("write");
		expect(mountedNames).not.toContain("mcp__nucleus_search");

		// Mount count drops to zero: write must NOT be demoted (catalogSize is
		// monotone), so the tools array keeps its exact shape.
		await session.refreshMCPTools([]);
		expect(wireToolNames()).toEqual(mountedNames);

		await session.refreshMCPTools([search]);
		expect(wireToolNames()).toEqual(mountedNames);
	});

	it("flushes a pending mount notice on an agent-driven prompt", async () => {
		// The stale-notice failure: deltas were withheld until a user-authored
		// prompt, so a session driven by runtime wakes acted for 20+ minutes on
		// an inventory it no longer had.
		const xdev = createXdevState();
		const { session, contexts } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdev,
			responses: [{ content: ["ok"] }],
		});
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		await session.refreshMCPTools([search]);

		await session.promptCustomMessage({
			customType: "agent-runtime-wake",
			content: "scheduled wake",
			display: false,
			attribution: "agent",
		});

		expect(contexts).toHaveLength(1);
		const notices = mountNoticesIn(contexts[0]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("xd://mcp__nucleus_search");
	});
});

describe("XdevState sticky catalog", () => {
	function deviceTool(name: string): AgentTool {
		return {
			name,
			label: name,
			description: `${name} device`,
			parameters: type({ value: "string" }),
			async execute() {
				return { content: [{ type: "text", text: `${name} ran` }] };
			},
		};
	}

	it("documents unmounted devices and reports them as unmounted, not unknown", async () => {
		const xdev = createXdevState();
		const dev = deviceTool("flaky_dev");
		xdev.tools.set(dev.name, dev);
		setXdevMountedNames(xdev, [dev.name]);
		xdev.tools.delete(dev.name);
		setXdevMountedNames(xdev, []);

		expect(xdev.catalog.size).toBe(1);
		expect(xdev.mountedNames.size).toBe(0);
		expect(xdevDocsAll(xdev)).toContain("flaky_dev");

		const { result } = await dispatchXdevTool(xdev, "flaky_dev", JSON.stringify({ value: "x" }), "call-1");
		const text = result.content.find(entry => entry.type === "text")?.text ?? "";
		expect(result.isError).toBe(true);
		expect(text).toContain("not currently mounted");

		const { result: unknown } = await dispatchXdevTool(xdev, "never_seen", "{}", "call-2");
		const unknownText = unknown.content.find(entry => entry.type === "text")?.text ?? "";
		expect(unknown.isError).toBe(true);
		expect(unknownText).toContain("No such tool:");
	});

	it("keeps catalogSize monotone across remounts", () => {
		const xdev = createXdevState([deviceTool("builtin_dev")]);
		expect(xdev.catalog.size).toBe(1);
		const a = deviceTool("a");
		const b = deviceTool("b");
		xdev.tools.set(a.name, a);
		xdev.tools.set(b.name, b);
		setXdevMountedNames(xdev, ["builtin_dev", "a", "b"]);
		expect(xdev.catalog.size).toBe(3);
		setXdevMountedNames(xdev, ["builtin_dev"]);
		expect(xdev.catalog.size).toBe(3);
		setXdevMountedNames(xdev, ["builtin_dev", "a"]);
		expect(xdev.catalog.size).toBe(3);
	});
});
