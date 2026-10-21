/**
 * The desktop window as `@tauri-apps/api/window` serves it to a page, for Bun
 * tests of this package and of the apps, which import it by relative path.
 * Importing it replaces that module.
 *
 * `onCloseRequested` runs a listener as the installed API runs it: the
 * handler is awaited, and the window is destroyed unless the handler
 * prevented it. With no listener, a close destroys the window at once, as
 * the shell does. `refuseDestroy` stands for a capability without
 * `core:window:allow-destroy`, whose `destroy` rejects.
 *
 * The page counts as the desktop app while `globalThis.isTauri` is true,
 * which `isTauri()` reads; `desktop(true)` sets it. Set it after a page
 * chose its folder engine, so the page still opens browser storage.
 */
import { mock } from 'bun:test';

type CloseRequested = { preventDefault(): void };
type Handler = (event: CloseRequested) => void | Promise<void>;

const handlers = new Set<Handler>();

export const nativeDialog = {
	answer: false as boolean | Promise<boolean>,
	count: 0,
	messages: [] as string[],
	reset() {
		this.answer = false;
		this.count = 0;
		this.messages.length = 0;
	},
};

mock.module('@tauri-apps/plugin-dialog', () => ({
	confirm: async (message: string) => {
		nativeDialog.count += 1;
		nativeDialog.messages.push(message);
		return nativeDialog.answer;
	},
}));

export const nativeWindow = {
	/** How many times the window was destroyed. */
	destroyed: 0,
	focused: 0,
	focus: undefined as Promise<void> | undefined,
	refuseFocus: false,
	/** Whether `destroy` rejects, as it does without `core:window:allow-destroy`. */
	refuseDestroy: false,
	/** Delay listener installation to test the editable-root opening boundary. */
	registration: undefined as Promise<void> | undefined,
	refuseRegistration: false,
	/** Delay destruction to test the final input boundary. */
	destruction: undefined as Promise<void> | undefined,
	/** How many close listeners are registered. */
	get listeners() {
		return handlers.size;
	},
	reset() {
		nativeDialog.reset();
		handlers.clear();
		this.destroyed = 0;
		this.focused = 0;
		this.focus = undefined;
		this.refuseFocus = false;
		this.refuseDestroy = false;
		this.registration = undefined;
		this.refuseRegistration = false;
		this.destruction = undefined;
		// A destroyed native page takes its inert DOM with it. Tests reuse one.
		if (globalThis.document) document.documentElement.inert = false;
		desktop(false);
	},
};

async function destroy() {
	await nativeWindow.destruction;
	if (nativeWindow.refuseDestroy)
		throw 'window.destroy not allowed. Permissions associated with this command: core:window:allow-destroy';
	nativeWindow.destroyed += 1;
}

mock.module('@tauri-apps/api/window', () => ({
	getCurrentWindow: () => ({
		label: 'test-folder',
		async onCloseRequested(handler: Handler) {
			await nativeWindow.registration;
			if (nativeWindow.refuseRegistration)
				throw new Error('Close listener could not be installed');
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		destroy,
		async setFocus() {
			await nativeWindow.focus;
			if (nativeWindow.refuseFocus) throw new Error('Window focus was refused');
			nativeWindow.focused += 1;
		},
	}),
}));

/** Wait until a close listener is registered; the page loads the window API first. */
export async function untilListening() {
	for (let tries = 0; tries < 400 && handlers.size === 0; tries++)
		await Bun.sleep(5);
	if (handlers.size === 0) throw new Error('No close listener was registered');
}

/** Count the page as desktop, supplying its inert root in headless tests. */
export function desktop(on: boolean) {
	if (on) {
		if (!globalThis.document)
			Object.assign(globalThis, {
				document: { documentElement: { inert: false } },
			});
		// jsdom does not implement inert's initial value.
		document.documentElement.inert ??= false;
	}
	(globalThis as { isTauri?: boolean }).isTauri = on;
}

/** The person clicks the window's close button; resolves once every listener answered. */
export async function requestClose(): Promise<void> {
	if (handlers.size === 0) {
		nativeWindow.destroyed += 1;
		return;
	}
	await Promise.all(
		[...handlers].map(async (handler) => {
			let prevented = false;
			await handler({
				preventDefault: () => {
					prevented = true;
				},
			});
			if (!prevented) await destroy();
		}),
	);
}
