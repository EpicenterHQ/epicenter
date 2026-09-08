/**
 * Blob requests stay with the principal that opened the session.
 * Verifies refusal before dispatch, cancellation across an auth retry, and
 * listener cleanup on both success and failure.
 */
import { expect, test } from 'bun:test';
import type { AuthClient, AuthState } from '@epicenter/auth';
import { asPrincipalId } from '@epicenter/principal';
import { createPrincipalFetch } from './principal-fetch.js';

const principalId = asPrincipalId('first');

function setup(fetch: AuthClient['fetch']) {
	let state: AuthState = { status: 'signed-in', principalId };
	const listeners = new Set<(state: AuthState) => void>();
	const client = {
		get state() {
			return state;
		},
		onStateChange(listener: (state: AuthState) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		fetch,
	};
	return {
		fetch: createPrincipalFetch(client, principalId),
		listeners,
		setState(next: AuthState) {
			state = next;
			for (const listener of listeners) listener(state);
		},
	};
}

test('a delayed upload cannot dispatch under a different principal', async () => {
	let calls = 0;
	const context = setup(async () => {
		calls++;
		return new Response();
	});
	context.setState({
		status: 'signed-in',
		principalId: asPrincipalId('second'),
	});
	await expect(context.fetch('https://example.test/blob')).rejects.toThrow(
		'no longer signed in',
	);
	expect(calls).toBe(0);
	expect(context.listeners.size).toBe(0);
});

test('an account switch aborts a suspended request before an authenticated retry', async () => {
	const entered = Promise.withResolvers<void>();
	const retry = Promise.withResolvers<void>();
	let sent = false;
	const context = setup(async (_input, init) => {
		entered.resolve();
		await retry.promise;
		init?.signal?.throwIfAborted();
		sent = true;
		return new Response();
	});
	const request = context.fetch('https://example.test/blob').catch((error: unknown) => error);
	await entered.promise;
	context.setState({
		status: 'signed-in',
		principalId: asPrincipalId('second'),
	});
	retry.resolve();
	expect(await request).toEqual(new Error('The blob request account is no longer signed in.'));
	expect(sent).toBe(false);
	expect(context.listeners.size).toBe(0);
});

test('same-account requests complete and preserve caller cancellation', async () => {
	let calls = 0;
	const context = setup(async () => {
		calls++;
		return new Response('ok');
	});
	expect(await (await context.fetch('https://example.test/blob')).text()).toBe(
		'ok',
	);
	const controller = new AbortController();
	controller.abort(new Error('caller stopped'));
	await expect(
		context.fetch('https://example.test/blob', { signal: controller.signal }),
	).rejects.toThrow('caller stopped');
	expect(calls).toBe(1);
	expect(context.listeners.size).toBe(0);
});
