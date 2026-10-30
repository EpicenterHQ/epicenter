/** The Folder plugin's caller-bound close protocol in page tests. */
import { mock } from 'bun:test';

type CloseChannel = { onmessage?: (value: null) => void | Promise<void> };
const handlers = new Map<number, CloseChannel>();
let nextToken = 0;
let phase: 'idle' | 'sent' | 'prompting' | 'ready' | 'gone' = 'idle';
const isReady = () => phase === 'ready';

export const nativeDialog = {
	// SAFETY: Tests replace this field with either a decision or a pending decision.
	answer: false as boolean | Promise<boolean>,
	count: 0,
	reset() {
		this.answer = false;
		this.count = 0;
	},
};

export const nativeWindow = {
	destroyed: 0,
	refuseDestroy: false,
	// SAFETY: Tests may delay registration with a promise.
	registration: undefined as Promise<void> | undefined,
	refuseRegistration: false,
	get listeners() {
		return handlers.size;
	},
	reset() {
		handlers.clear();
		phase = 'idle';
		this.destroyed = 0;
		this.refuseDestroy = false;
		this.registration = undefined;
		this.refuseRegistration = false;
		nativeDialog.reset();
		if (globalThis.document) document.documentElement.inert = false;
		desktop(false);
	},
};

async function destroy(token: number): Promise<boolean> {
	if (!handlers.has(token) || phase === 'idle' || phase === 'gone')
		return false;
	if (phase === 'prompting') {
		phase = 'ready';
		return true;
	}
	if (nativeWindow.refuseDestroy) {
		phase = 'idle';
		throw new Error('The bound window could not be destroyed');
	}
	phase = 'gone';
	nativeWindow.destroyed++;
	return true;
}

mock.module('@tauri-apps/api/core', () => ({
	Channel: class {
		onmessage?: (value: null) => void | Promise<void>;
	},
	// SAFETY: The test harness sets this optional marker on the global object.
	isTauri: () => (globalThis as { isTauri?: boolean }).isTauri === true,
	invoke: async (
		command: string,
		args?: { onClose?: CloseChannel; token?: number },
	) => {
		switch (command) {
			case 'plugin:epicenter-folder|subscribe_close': {
				await nativeWindow.registration;
				if (nativeWindow.refuseRegistration)
					throw new Error('Close listener could not be installed');
				const token = nextToken++;
				handlers.set(token, args?.onClose ?? {});
				phase = 'idle';
				return token;
			}
			case 'plugin:epicenter-folder|unsubscribe_close':
				handlers.delete(args?.token ?? -1);
				return null;
			case 'plugin:epicenter-folder|destroy_bound_window':
				return destroy(args?.token ?? -1);
			default:
				throw new Error(`Unexpected command ${command}`);
		}
	},
}));

export async function untilListening() {
	for (let tries = 0; tries < 400 && handlers.size === 0; tries++)
		await Bun.sleep(5);
	if (handlers.size === 0) throw new Error('No close listener was registered');
}

export function desktop(on: boolean) {
	if (on) {
		if (!globalThis.document)
			Object.assign(globalThis, {
				document: { documentElement: { inert: false } },
			});
		if (!globalThis.window)
			Object.assign(globalThis, { window: new EventTarget() });
		document.documentElement.inert ??= false;
	}
	// SAFETY: The test harness owns this optional marker on the global object.
	(globalThis as { isTauri?: boolean }).isTauri = on;
}

export async function requestClose(): Promise<void> {
	if (handlers.size === 0) {
		nativeWindow.destroyed++;
		return;
	}
	if (phase === 'gone' || phase === 'prompting' || phase === 'ready') return;
	if (phase === 'sent') {
		phase = 'prompting';
		nativeDialog.count++;
		const confirmed = await nativeDialog.answer;
		if (confirmed || isReady()) {
			if (nativeWindow.refuseDestroy) {
				phase = 'idle';
				return;
			}
			phase = 'gone';
			nativeWindow.destroyed++;
		} else {
			phase = 'sent';
		}
		return;
	}
	phase = 'sent';
	await Promise.all(
		[...handlers.values()].map((channel) => channel.onmessage?.(null)),
	);
}
