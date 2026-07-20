import { describe, expect, it } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { shouldDisposeGlobalLifecycle } from "@oh-my-pi/pi-coding-agent/sdk";

function registerAgent(registry: AgentRegistry, id: string, kind: "main" | "sub" = "main"): AgentRef {
	return registry.register({
		id,
		displayName: id,
		kind,
		session: null,
		status: "running",
	});
}

function createBus(): { bus: IrcBus; registry: AgentRegistry } {
	const registry = new AgentRegistry();
	return { bus: new IrcBus(registry), registry };
}

describe("AgentRegistry identity-guarded teardown", () => {
	it("removes a ref that is still current", () => {
		const registry = new AgentRegistry();
		const ref = registerAgent(registry, MAIN_AGENT_ID);
		registry.unregisterRef(ref);
		expect(registry.get(MAIN_AGENT_ID)).toBeUndefined();
	});

	it("does not let an old teardown remove a replacement ref", () => {
		const registry = new AgentRegistry();
		const oldRef = registerAgent(registry, MAIN_AGENT_ID);
		const currentRef = registerAgent(registry, MAIN_AGENT_ID);
		registry.unregisterRef(oldRef);
		expect(registry.get(MAIN_AGENT_ID)).toBe(currentRef);
		registry.unregisterRef(currentRef);
		expect(registry.get(MAIN_AGENT_ID)).toBeUndefined();
	});

	it("lets only the current main dispose the global lifecycle", () => {
		const registry = new AgentRegistry();
		const supersededRef = registerAgent(registry, MAIN_AGENT_ID);
		const currentRef = registerAgent(registry, MAIN_AGENT_ID);
		expect(shouldDisposeGlobalLifecycle("main", registry, MAIN_AGENT_ID, supersededRef)).toBe(false);
		expect(shouldDisposeGlobalLifecycle("main", registry, MAIN_AGENT_ID, currentRef)).toBe(true);
		expect(shouldDisposeGlobalLifecycle("sub", registry, MAIN_AGENT_ID, currentRef)).toBe(false);
	});
});

describe("IrcBus transition durability", () => {
	it("buffers mail to temporarily unregistered Main", async () => {
		const { bus } = createBus();
		const receipt = await bus.send({ from: "peer", to: MAIN_AGENT_ID, body: "lane report" });
		expect(receipt).toMatchObject({ outcome: "failed", error: expect.stringContaining("buffered") });
		expect(bus.inbox(MAIN_AGENT_ID).map(message => message.body)).toEqual(["lane report"]);
	});

	it("lets a ref-less pending wait consume mail directly", async () => {
		const { bus } = createBus();
		const wait = bus.wait(MAIN_AGENT_ID, { from: "peer" }, 5000);
		const receipt = await bus.send({ from: "peer", to: MAIN_AGENT_ID, body: "direct" });
		expect(receipt.outcome).toBe("injected");
		expect((await wait)?.body).toBe("direct");
		expect(bus.unreadCount(MAIN_AGENT_ID)).toBe(0);
	});

	it("keeps unknown peer names loud and unbuffered", async () => {
		const { bus } = createBus();
		const receipt = await bus.send({ from: "peer", to: "tyop", body: "miss" });
		expect(receipt).toMatchObject({ outcome: "failed", error: expect.stringContaining("Unknown agent") });
		expect(bus.unreadCount("tyop")).toBe(0);
	});

	it("buffers mail while a known ref has no session", async () => {
		const { bus, registry } = createBus();
		registry.register({
			id: "detached",
			displayName: "detached",
			kind: "sub",
			session: null,
			status: "idle",
		});
		const receipt = await bus.send({ from: "peer", to: "detached", body: "mid-transition" });
		expect(receipt).toMatchObject({ outcome: "failed", error: expect.stringContaining("buffered") });
		expect(bus.inbox("detached").map(message => message.body)).toEqual(["mid-transition"]);
	});

	it("does not buffer mail to an aborted ref", async () => {
		const { bus, registry } = createBus();
		const ref = registerAgent(registry, "aborted", "sub");
		registry.setStatus(ref.id, "aborted");
		const receipt = await bus.send({ from: "peer", to: ref.id, body: "nope" });
		expect(receipt).toMatchObject({ outcome: "failed", error: expect.stringContaining("hard-aborted") });
		expect(bus.unreadCount(ref.id)).toBe(0);
	});
});
