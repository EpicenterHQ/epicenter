/**
 * Todos' capabilities, opened once for the page's life (ADR-0766): the
 * account (the web build's sign-in; the desktop window never signs in) and
 * the folder, adapted for Svelte here, once. Every page, component and
 * module imports what it uses from here.
 *
 * The folder is the one store of the build: this browser has none, so the
 * web opens the signed-in person's `todos` repository, and the desktop
 * window opens the folder Todos keeps its todos in. Under the `test`
 * condition it is a folder in memory.
 */
import { APPS } from '@epicenter/definition/site';
import { openFolder } from '@epicenter/folder';
import { fromClient } from '@epicenter/svelte/client';
import { connectAccount } from '#platform/account';
import { todos } from './contract.js';

export const account = connectAccount();
const opened = openFolder(todos, {
	site: APPS.TODOS.url,
	...(account && { account }),
});
export const folder = fromClient(opened);

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		opened[Symbol.dispose]();
		account?.[Symbol.dispose]();
	});
	// Vite runs only the disposer of the module an update was accepted at, and
	// the components importing this one accept their own updates: without
	// this, an edit here leaves the old folder and account open. Accepting,
	// then invalidating, closes them first and hands the update up as before.
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
