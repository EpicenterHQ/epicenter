import type * as NativeWindowEvents from './window-events.tauri.js';

// The browser renders its indicator inline and dispatches actions directly.
// There is no secondary window to notify or subscribe to in this build.
export const defineWindowEvent: typeof NativeWindowEvents.defineWindowEvent =
	() => ({
		async emit() {},
		async emitTo() {},
		async listen() {
			return () => {};
		},
	});

export const defineWindowSignal: typeof NativeWindowEvents.defineWindowSignal =
	() => ({
		async emit() {},
		async listen() {
			return () => {};
		},
	});
