/**
 * `todos.sync`: commit the saved files, fetch, merge, and push. Sync asks
 * nothing: what both sides changed merges, this device's version winning
 * (ADR-0576). Given a remote URL, it connects first: the URL becomes the
 * folder's remote, and the same sync runs. Separate histories are
 * `Unrelated` until the person agrees to combine them.
 */
import type { TodosParts } from './todos.svelte.js';

/** A remote to connect to; `combine` agrees to merge separate histories. */
export type ConnectTo = { readonly url: string; readonly combine?: boolean };

export function createSync({ edits, defineMutation }: TodosParts) {
	return {
		/** Sync now, or connect to `url` and sync. What is typed and the writes still running land first. */
		run: defineMutation({
			mutationKey: ['todos', 'sync'],
			mutationFn: (
				// biome-ignore lint/suspicious/noConfusingVoidType: TanStack lets `run()` take no input only when its variables admit `void`.
				connect: ConnectTo | void,
			) =>
				edits.sync(
					connect
						? { url: connect.url, allowUnrelatedHistories: connect.combine }
						: undefined,
				),
		}),
	};
}
