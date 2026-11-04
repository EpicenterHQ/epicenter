/**
 * PROTOTYPE option (d): a lazy module singleton. `openApp()` opens the world
 * once (a failure forgets the attempt, so the next call retries) and fills
 * the live bindings pages import as plain values. Before it resolves they
 * are `undefined`, whatever their type says.
 */
import { openWorld, type World } from '../open.js';

export let folder: World['folder'];
export let todos: World['todos'];

let opening: Promise<true> | undefined;

export function openApp(): Promise<true> {
	opening ??= openWorld('d').then(
		(world) => {
			folder = world.folder;
			todos = world.todos;
			return true as const;
		},
		(error: unknown) => {
			opening = undefined;
			throw error;
		},
	);
	return opening;
}
