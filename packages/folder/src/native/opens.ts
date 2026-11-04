/**
 * The root each desktop client or folder opened, and the path the shell
 * answered for it: what `rootOf` and `displayPath` from `/tauri` read.
 */
import type { Root } from './bindings.gen.js';

export type Opened = { root: Root; path: string };

const opens = new WeakMap<object, Opened>();

/** Remember that `target`, a client or a folder, opened `root` at `path`. */
export function recordOpen(target: object, opened: Opened): void {
	opens.set(target, opened);
}

/** The path `target` opened at, or null when it has not opened. */
export function pathOf(target: object): string | null {
	return opens.get(target)?.path ?? null;
}

/** What `target` opened; throws for anything the desktop did not open, or a folder not open yet. */
export function openOf(target: object): Opened {
	const opened = opens.get(target);
	if (opened === undefined)
		throw new Error(
			'expected a client openDevice from /tauri returned, or a desktop folder that opened',
		);
	return opened;
}
