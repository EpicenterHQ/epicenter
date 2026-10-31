/**
 * What Todos' `#platform/*` seam (`package.json` "imports") promises every
 * build. The build picks the leaf: the online web app's by default, the
 * desktop window's under the `tauri` condition (`bun run build:native`).
 * Each leaf annotates against these types, so both stay one shape.
 */
import type { ReactiveClient, ReactiveNotes } from '@epicenter/svelte/client';
import type { Component, Snippet } from 'svelte';
import type { Todos } from './contract.js';
import type { TodoNotes } from './todos.js';

/**
 * What the header tells `Chrome`: why the todos did not list, if they did
 * not, and whether a typed new todo is still waiting for Add.
 */
export type ChromeProps = {
	unreadable: ReactiveNotes<TodoNotes>['error'];
	pendingNewTodo: boolean;
};

/**
 * `#platform/root`: the one thing a variant decides (decision 78).
 * `Startup` opens the store and renders the pages over it: the person's
 * repository, signed in, on the web; the folder Todos keeps its todos in on
 * the desktop, or its recovery screen. `store()` is that store, as the
 * pages read it. `Chrome` is the header's account of it: where the todos
 * are, and what can be done about it (sign out, or Sync with Epicenter).
 */
export type Platform = {
	Startup: Component<{ children: Snippet }>;
	store: () => ReactiveClient<Todos>;
	Chrome: Component<ChromeProps>;
};
