import { describe, expect, it } from "bun:test";
import { dispatchXdevTool, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { type } from "arktype";

// Prose affordance: a device whose schema has exactly one REQUIRED string
// field accepts a plain-text write as that field. Live papercut 2026-07-24:
// `write xd://complain <prose>` failed with `expects a JSON args object as
// content (JSON Parse error: Unexpected identifier "cron")` even though the
// only required field is one freeform string.
function makeProseTool() {
	const tool = {
		name: "grumble",
		label: "Grumble",
		description: "Fake complain-shaped device",
		parameters: type({ complaint: "string", "severity?": "string" }),
		calls: [] as Array<Record<string, unknown>>,
		async execute(_id: string, args: Record<string, unknown>) {
			tool.calls.push(args);
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
	return tool;
}

function makeStrictTool() {
	const tool = {
		name: "strict",
		label: "Strict",
		description: "Two required fields — prose must still be rejected",
		parameters: type({ left: "string", right: "string" }),
		calls: [] as Array<Record<string, unknown>>,
		async execute(_id: string, args: Record<string, unknown>) {
			tool.calls.push(args);
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
	return tool;
}

function mount(tool: ReturnType<typeof makeProseTool> | ReturnType<typeof makeStrictTool>): XdevState {
	const tools = new Map([[tool.name, tool as never]]);
	return {
		tools,
		mountedNames: new Set([tool.name]),
		catalog: new Map(tools),
		builtInNames: new Set([tool.name]),
		isActive: () => false,
	};
}

describe("xd:// prose-shaped devices", () => {
	it("routes a plain-text write into the sole required string field", async () => {
		const prose = makeProseTool();
		await dispatchXdevTool(mount(prose), "grumble", "cron ids collide across owners", "call-1");
		expect(prose.calls).toEqual([{ complaint: "cron ids collide across owners" }]);
	});

	it("wraps a bare JSON string write the same way", async () => {
		const prose = makeProseTool();
		await dispatchXdevTool(mount(prose), "grumble", JSON.stringify("quoted prose"), "call-2");
		expect(prose.calls).toEqual([{ complaint: "quoted prose" }]);
	});

	it("still parses real JSON objects with optional fields", async () => {
		const prose = makeProseTool();
		await dispatchXdevTool(
			mount(prose),
			"grumble",
			JSON.stringify({ complaint: "body", severity: "papercut" }),
			"call-3",
		);
		expect(prose.calls).toEqual([{ complaint: "body", severity: "papercut" }]);
	});

	it("keeps rejecting prose for devices with more than one required field", async () => {
		const strict = makeStrictTool();
		const { result } = await dispatchXdevTool(mount(strict), "strict", "not json", "call-4");
		const text = result.content.find(entry => entry.type === "text")?.text ?? "";
		expect(text).toContain("expects a JSON args object");
		expect(strict.calls).toEqual([]);
	});
});
