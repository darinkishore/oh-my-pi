import { logger } from "@oh-my-pi/pi-utils";

interface ScopedSubscription {
	channel: string;
	handler: (data: unknown) => void;
	cancelled: boolean;
	unsubscribe?: () => void;
}

export class EventBus {
	readonly #listeners = new Map<string, Set<(data: unknown) => void>>();

	emit(channel: string, data: unknown): void {
		const handlers = this.#listeners.get(channel);
		if (handlers) {
			for (const handler of handlers) {
				handler(data);
			}
		}
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		if (!this.#listeners.has(channel)) {
			this.#listeners.set(channel, new Set());
		}
		const safeHandler = async (data: unknown) => {
			try {
				await handler(data);
			} catch (err) {
				logger.error("Event handler error", { channel, error: String(err) });
			}
		};
		this.#listeners.get(channel)!.add(safeHandler);
		return () => this.#listeners.get(channel)?.delete(safeHandler);
	}

	clear(): void {
		this.#listeners.clear();
	}
}

/**
 * An extension-owned view of a shared bus. Subscriptions are recorded so a
 * hot reload can dispose one extension instance without disturbing the host or
 * other extensions.
 */
export class ScopedEventBus extends EventBus {
	#active: boolean;
	readonly #pending = new Set<ScopedSubscription>();
	readonly #shared: EventBus;
	readonly #disposers: Array<() => void>;

	constructor(shared: EventBus, disposers: Array<() => void>, active = true) {
		super();
		this.#shared = shared;
		this.#disposers = disposers;
		this.#active = active;
	}

	override emit(channel: string, data: unknown): void {
		this.#shared.emit(channel, data);
	}

	override on(channel: string, handler: (data: unknown) => void): () => void {
		const subscription: ScopedSubscription = { channel, handler, cancelled: false };
		this.#pending.add(subscription);
		if (this.#active) {
			this.#activateSubscription(subscription);
		}
		return () => {
			subscription.cancelled = true;
			subscription.unsubscribe?.();
			this.#pending.delete(subscription);
		};
	}

	activate(): void {
		if (this.#active) {
			return;
		}
		this.#active = true;
		for (const subscription of this.#pending) {
			this.#activateSubscription(subscription);
		}
	}

	override clear(): void {
		for (const subscription of this.#pending) {
			subscription.cancelled = true;
		}
		this.#pending.clear();
		for (const dispose of this.#disposers.splice(0)) {
			dispose();
		}
	}

	#activateSubscription(subscription: ScopedSubscription): void {
		if (subscription.cancelled || subscription.unsubscribe) {
			return;
		}
		subscription.unsubscribe = this.#shared.on(subscription.channel, subscription.handler);
		this.#disposers.push(subscription.unsubscribe);
	}
}
