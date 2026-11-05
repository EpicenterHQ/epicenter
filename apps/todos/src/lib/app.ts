/**
 * Todos' capabilities, opened once for the page's life (ADR-0766): the
 * account and the folder, each read through `reactive` here, once, under
 * its own names. Every page, component and module imports what it uses from
 * here.
 *
 * Todos uses its account for its folder alone. In a browser the folder is
 * the signed-in person's `todos` repository, and this browser keeps none of
 * it; in a Tauri window it is the folder Todos keeps its todos in on this
 * computer, which needs no account: signing in there is to sync it
 * (ADR-0785). Under the `test` condition the folder is in memory.
 */
import { connectAccount } from '@epicenter/account';
import { APPS } from '@epicenter/definition/site';
import { home, openFolder } from '@epicenter/folder';
import { reactive } from '@epicenter/svelte/reactive';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/vite-config/app-urls';
import { todos } from './contract.js';

const signIn = connectAccount({
	clientId: 'so.epicenter.todos',
	api: APP_URLS.API,
	selfHosted: SELF_HOST_ORIGIN,
});

export const account = reactive(signIn);
export const folder = reactive(
	openFolder(todos, home({ site: APPS.TODOS.url, account: signIn })),
);
