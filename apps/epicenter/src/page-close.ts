/**
 * A page's side of Epicenter's close flush, imported as
 * `@epicenter/epicenter/page-close`. Only a page's Epicenter host build
 * imports it; a browser build has no host to hear.
 *
 * Before the process quits or restarts, the native host sends this window one
 * `flush-on-close` event and waits about a second for `flush_done`
 * (`src-tauri/src/close_flush.rs`). Nothing is asked: the page flushes the
 * saves it has in flight and answers, and the host leaves either way.
 *
 * ```text
 * Rust -> page   emit_to(label, "flush-on-close", ())   no payload
 * page -> Rust   flush_done()                           once its flush ends
 * Rust -> page   emit_to(label, "host-stopped", ())     the Bun host stopped
 * ```
 *
 * Events are heard on this window only. Registering happens when a function
 * here is called, never on import.
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export const FLUSH_ON_CLOSE_EVENT = 'flush-on-close';
export const FLUSH_DONE_COMMAND = 'flush_done';
export const HOST_STOPPED_EVENT = 'host-stopped';

/**
 * Hear the host's close signal: run `respond`, then tell the host it is done,
 * whatever `respond` found. Resolves to how to stop listening. Fits
 * `flushOnClose`'s `hostClose` from `@epicenter/svelte/flush-on-close`.
 */
export function onHostClose(
	respond: () => Promise<unknown>,
): Promise<() => void> {
	return getCurrentWebviewWindow().listen(FLUSH_ON_CLOSE_EVENT, async () => {
		try {
			await respond();
		} finally {
			await invoke(FLUSH_DONE_COMMAND).catch(() => {});
		}
	});
}

/** Run `listener` when the Bun host that served this page stops. */
export function onHostStopped(listener: () => void): Promise<() => void> {
	return getCurrentWebviewWindow().listen(HOST_STOPPED_EVENT, () =>
		listener(),
	);
}
