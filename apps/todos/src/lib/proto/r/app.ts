/**
 * PROTOTYPE option (r), the recommended shape: `openApp()` opens every value
 * the app needs, the type is derived from it, and one context carries it.
 * `openWorld` stands in for `openFolder(todos)` and the synchronous
 * capabilities composed after it.
 */
import { createContext } from 'svelte';
import { openWorld } from '../open.js';

export async function openApp() {
	const { folder, todos } = await openWorld('r');
	const label = (count: number) => `${count} todos`;
	return { folder, todos, label };
}

export type App = Awaited<ReturnType<typeof openApp>>;

export const [getApp, setApp] = createContext<App>();
