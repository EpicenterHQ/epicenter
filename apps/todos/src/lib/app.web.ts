/**
 * `#platform/app` in the web build: the signed-in person's `todos`
 * repository, online only (ADR-0700). The account is read once; a different
 * one (signed out, or another person, here or in another tab) reloads the
 * page. Signed out, the world does not open: the recovery screen offers
 * sign-in.
 */
import { openRemote } from '@epicenter/folder/remote';
import { fromClient } from '@epicenter/svelte/client';
import { createWebAuth } from './auth.js';
import { todos as contract } from './contract.js';
import { StartupFailed } from './startup.js';
import type { TodoList } from './todos.js';

/** Why the web world did not open, and the fix the recovery screen offers. */
export type StartupFailure = {
	name: 'SignedOut';
	signIn: () => ReturnType<typeof auth.startSignIn>;
};

/** This page's sign-in. */
export const auth = createWebAuth();

// A snapshot: outside a reactive context the read does not track.
const { state } = auth;
if (state.status === 'signed-out')
	throw new StartupFailed<StartupFailure>(
		'Sign in to use the todos in your Epicenter repository.',
		{ name: 'SignedOut', signIn: () => auth.startSignIn() },
	);

/** The account this page was opened for. */
export const account = state.account;

let leaving = false;
auth.onStateChange((next) => {
	if (!leaving && next.account !== account) location.reload();
});

/** Sign out, revoke, then reload: the next page starts signed out. */
export async function signOut() {
	leaving = true;
	const result = await auth.signOut();
	location.reload();
	return result;
}

export const todos: TodoList = fromClient(openRemote(contract, { account }))
	.todos;

// A new world is a new page, in development too.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
