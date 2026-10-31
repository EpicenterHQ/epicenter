/**
 * Desktop Sign-In Tests
 *
 * Vocab's desktop `AuthClient` (`auth.tauri.ts`) over a stand-in for the
 * native shell's account commands (`src-tauri/src/account.rs`).
 *
 * Key behaviors:
 * - The state is the shell's: signed out, signed in, or refused (reauth)
 * - Signing in again as the same person keeps the Account; another person,
 *   or signing out, retires it
 * - The account's fetch goes through the shell to the deployment only, and
 *   streams the answer back; a refusal, an abort, and a bodiless status each
 *   end it the way `fetch` would
 */
import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type AccountShell,
	createDesktopAuth,
	relayFetch,
} from './auth.tauri.js';

const ORIGIN = 'https://api.epicenter.so';
const PERSON = { origin: ORIGIN, principalId: 'person-1' };

type Sent = { command: string; args?: Record<string, unknown> };
type Listener = (message: unknown) => void;

/** A shell that answers each command with `answer`, recording what was sent. */
function shell(
	answer: (command: string, args?: Record<string, unknown>) => unknown,
) {
	const sent: Sent[] = [];
	const fake: AccountShell = {
		async invoke<T>(command: string, args?: Record<string, unknown>) {
			sent.push({ command, args });
			const value = answer(command, args);
			if (value instanceof Error) throw value;
			return value as T;
		},
		channel: (onMessage: Listener) => ({ onMessage }),
	};
	return { fake, sent };
}

/** Send `messages` on the channel `account_fetch` was given, in order. */
function replying(...messages: unknown[]) {
	return (command: string, args?: Record<string, unknown>) => {
		if (command !== 'account_fetch') return null;
		const channel = args?.onEvent as { onMessage: Listener };
		const { onMessage } = channel;
		queueMicrotask(() => {
			for (const message of messages) onMessage(message);
		});
		return null;
	};
}

describe('state', () => {
	test('is what the shell says, refused included', async () => {
		for (const [answer, status] of [
			[{ origin: ORIGIN, signedIn: null, refused: false }, 'signed-out'],
			[{ origin: ORIGIN, signedIn: PERSON, refused: false }, 'signed-in'],
			[{ origin: ORIGIN, signedIn: PERSON, refused: true }, 'reauth-required'],
		] as const) {
			const { client, ready } = createDesktopAuth(shell(() => answer).fake);
			await ready;
			const state = client.getState();
			expect(state.status).toBe(status);
			expect(client.baseURL).toBe(ORIGIN);
			if (state.status !== 'signed-out') {
				expect(String(state.account.principalId)).toBe('person-1');
				expect(state.account.baseURL).toBe(ORIGIN);
			}
		}
	});

	test('a shell that cannot answer leaves it signed out', async () => {
		const { client, ready } = createDesktopAuth(
			shell(() => new Error('no shell')).fake,
		);
		await ready;
		expect(client.getState().status).toBe('signed-out');
	});
});

describe('signing in and out', () => {
	test('the same person keeps the Account; another retires it', async () => {
		let who = PERSON;
		const { fake } = shell((command) => {
			if (command === 'account_state')
				return { origin: ORIGIN, signedIn: PERSON, refused: true };
			if (command === 'account_sign_in') return who;
			return null;
		});
		const { client, ready } = createDesktopAuth(fake);
		await ready;
		const seen: string[] = [];
		client.onStateChange((state) => seen.push(state.status));
		const first = client.getState().account;
		expectOk(await client.startSignIn());
		expect(client.getState().status).toBe('signed-in');
		expect(client.getState().account).toBe(first);
		who = { origin: ORIGIN, principalId: 'person-2' };
		expectOk(await client.startSignIn());
		expect(first?.signal.aborted).toBe(true);
		expect(String(client.getState().account?.principalId)).toBe('person-2');
		expect(seen).toEqual(['signed-in', 'signed-in']);
	});

	test('a sign-in that failed says so and changes nothing', async () => {
		const { fake } = shell((command) =>
			command === 'account_sign_in'
				? new Error('The browser did not come back within ten minutes.')
				: { origin: ORIGIN, signedIn: null, refused: false },
		);
		const { client, ready } = createDesktopAuth(fake);
		await ready;
		const error = expectErr(await client.startSignIn());
		expect(error.name).toBe('StartSignInFailed');
		expect(error.message).toContain('ten minutes');
		expect(client.getState().status).toBe('signed-out');
	});

	test('signing out retires the Account', async () => {
		const { fake, sent } = shell((command) =>
			command === 'account_state'
				? { origin: ORIGIN, signedIn: PERSON, refused: false }
				: null,
		);
		const { client, ready } = createDesktopAuth(fake);
		await ready;
		const account = client.getState().account;
		expectOk(await client.signOut());
		expect(sent.map(({ command }) => command)).toContain('account_sign_out');
		expect(client.getState().status).toBe('signed-out');
		if (account === undefined) throw new Error('signed in before signing out');
		expect(account.signal.aborted).toBe(true);
		await expect(account.fetch(`${ORIGIN}/v1/models`)).rejects.toThrow();
	});
});

describe('the account’s fetch', () => {
	const live = new AbortController().signal;

	test('streams the deployment’s answer back through the shell', async () => {
		const encoder = new TextEncoder();
		const { fake, sent } = shell(
			replying(
				{
					kind: 'head',
					status: 200,
					headers: [['content-type', 'text/plain']],
				},
				encoder.encode('Hello, ').buffer,
				Array.from(encoder.encode('learner')),
				{ kind: 'end' },
			),
		);
		const fetch = relayFetch(fake, ORIGIN, live, () => {});
		const response = await fetch('/v1/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{"a":1}',
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/plain');
		expect(await response.text()).toBe('Hello, learner');
		const request = sent[0]?.args?.request as Record<string, unknown>;
		expect(request.url).toBe(`${ORIGIN}/v1/chat`);
		expect(request.method).toBe('POST');
		expect(atob(request.body as string)).toBe('{"a":1}');
		expect(request.headers).toContainEqual([
			'content-type',
			'application/json',
		]);
	});

	test('a request anywhere but the deployment is refused here', async () => {
		const { fake, sent } = shell(() => null);
		const fetch = relayFetch(fake, ORIGIN, live, () => {});
		for (const url of [
			'https://api.epicenter.so.evil.com/v1',
			'https://evil.com/v1',
			'https://user:pass@api.epicenter.so/v1',
		])
			await expect(fetch(url)).rejects.toThrow(TypeError);
		expect(sent).toEqual([]);
	});

	test('a refusal is AccountUnavailable and is reported', async () => {
		const refusals: string[] = [];
		const { fake } = shell(
			replying({
				kind: 'error',
				message: 'Sign in again.',
				refusal: 'reauth-required',
			}),
		);
		const fetch = relayFetch(fake, ORIGIN, live, (code) => refusals.push(code));
		const error = await fetch(`${ORIGIN}/v1/models`).catch((cause) => cause);
		expect(error.name).toBe('AccountUnavailable');
		expect(error.code).toBe('reauth-required');
		expect(refusals).toEqual(['reauth-required']);
	});

	test('an abort cancels the request in the shell', async () => {
		const { fake, sent } = shell(() => null);
		const fetch = relayFetch(fake, ORIGIN, live, () => {});
		const controller = new AbortController();
		const pending = fetch(`${ORIGIN}/v1/chat`, { signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toThrow();
		await Promise.resolve();
		expect(sent.map(({ command }) => command)).toEqual([
			'account_fetch',
			'account_fetch_cancel',
		]);
	});

	test('a bodiless status answers with no body', async () => {
		const { fake } = shell(
			replying({ kind: 'head', status: 204, headers: [] }, { kind: 'end' }),
		);
		const response = await relayFetch(fake, ORIGIN, live, () => {})(
			`${ORIGIN}/x`,
		);
		expect(response.status).toBe(204);
		expect(response.body).toBeNull();
	});

	test('the profile is who userinfo names', async () => {
		const encoder = new TextEncoder();
		const { fake } = shell((command, args) => {
			if (command === 'account_state')
				return { origin: ORIGIN, signedIn: PERSON, refused: false };
			return replying(
				{
					kind: 'head',
					status: 200,
					headers: [['content-type', 'application/json']],
				},
				encoder.encode(JSON.stringify({ sub: 'person-1', email: 'a@b.c' }))
					.buffer,
				{ kind: 'end' },
			)(command, args);
		});
		const { client, ready } = createDesktopAuth(fake);
		await ready;
		expect(expectOk(await client.getProfile()) as unknown).toEqual({
			id: 'person-1',
			email: 'a@b.c',
		});
	});
});
