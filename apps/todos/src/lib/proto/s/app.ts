/**
 * PROTOTYPE option (s): `openApp()` is synchronous and builds only values.
 * The folder is opening when it returns; readiness is `app.folder.state()`.
 */
import { createContext } from 'svelte';
import { todos } from '../../contract.js';
import { openFolder } from './folder.js';
import { modelChoices } from './model-choices.js';

export function openApp() {
	const folder = openFolder(todos);
	const models = modelChoices();
	const label = (count: number) => `${count} todos`;
	return {
		folder,
		models,
		label,
		[Symbol.dispose]() {
			folder[Symbol.dispose]();
			models[Symbol.dispose]();
		},
	};
}

export type App = ReturnType<typeof openApp>;

export const [getApp, setApp] = createContext<App>();
