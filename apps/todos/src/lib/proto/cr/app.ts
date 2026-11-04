/**
 * PROTOTYPE option (c) as reviewed: `openApp()` awaits the folder, the type
 * is the awaited return, one context carries it, and it can be disposed.
 */
import { createContext } from 'svelte';
import { closeWorld, openWorld } from '../open.js';
import { modelChoices } from '../s/model-choices.js';

export async function openApp() {
	const models = modelChoices();
	const world = await openWorld('cr');
	const label = (count: number) => `${count} todos`;
	return {
		folder: world.folder,
		todos: world.todos,
		models,
		label,
		[Symbol.dispose]() {
			closeWorld(world);
			models[Symbol.dispose]();
		},
	};
}

export type App = Awaited<ReturnType<typeof openApp>>;

export const [getApp, setApp] = createContext<App>();
