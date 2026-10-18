/**
 * A page's side of Epicenter's host-stopped signal, imported as
 * `@epicenter/epicenter/host-stopped`. Only a page's Epicenter host build
 * imports it; a browser build has no host to hear.
 *
 * When the Bun host that served a Capture or Todos window stops, the native
 * shell keeps the window and its page, so a person can recover unsaved text,
 * and tells the page once (`invalidate_windows` in `src-tauri/src/lib.rs`):
 *
 * ```text
 * Rust -> page   emit_to(label, "host-stopped", ())
 * ```
 *
 * The event is heard on this window only. Registering happens when the
 * function here is called, never on import.
 */
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export const HOST_STOPPED_EVENT = 'host-stopped';

/** Run `listener` when the Bun host that served this page stops. */
export function onHostStopped(listener: () => void): Promise<() => void> {
	return getCurrentWebviewWindow().listen(HOST_STOPPED_EVENT, () => listener());
}
