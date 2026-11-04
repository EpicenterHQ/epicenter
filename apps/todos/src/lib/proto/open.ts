/**
 * PROTOTYPE. The one opener every option awaits: this origin's private files
 * (OPFS) as Todos' typed client, behind two knobs read from the URL:
 * `?delay=<ms>` waits first, `?fail=<n>` throws for the first n opens of
 * this tab (counted in sessionStorage, so a reload counts on).
 *
 * `opens()` counts how often this page opened a world, so a probe can see a
 * hot reload or an invalidation reopen it.
 */
import type { Client } from '@epicenter/definition/contract';
import { openDevice } from '@epicenter/folder/browser';
import { fromClient, type ReactiveNotes } from '@epicenter/svelte/client';
import { todos as contract, type Todos } from '../contract.js';
import type { TodoNotes } from '../todos.js';

export class OpenFailed extends Error {
	override name = 'OpenFailed';
}

const counter = globalThis as unknown as { __opens?: number };
export const opens = () => counter.__opens ?? 0;

/** The world every option opens: the folder, and its todos wrapped for Svelte. */
export type World = { folder: Client<Todos>; todos: ReactiveNotes<TodoNotes> };

export async function openWorld(label: string): Promise<World> {
	counter.__opens = opens() + 1;
	console.log(`[open ${label}] #${counter.__opens}`);
	const params = new URLSearchParams(location.search);
	const delay = Number(params.get('delay') ?? 0);
	if (delay > 0) await new Promise((r) => setTimeout(r, delay));
	const fail = Number(params.get('fail') ?? 0);
	const failed = Number(sessionStorage.getItem('proto.failed') ?? 0);
	if (failed < fail) {
		sessionStorage.setItem('proto.failed', String(failed + 1));
		throw new OpenFailed(`could not open (failure ${failed + 1} of ${fail})`);
	}
	const opened = await openDevice(contract);
	if (opened.error !== null) throw new OpenFailed(opened.error.message);
	return { folder: opened.data, todos: fromClient(opened.data).todos };
}
