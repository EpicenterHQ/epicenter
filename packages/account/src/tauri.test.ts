/**
 * Desktop Sign-In Tests
 *
 * The standalone desktop apps' `AuthClient` (`tauri.ts`) over a stand-in for
 * the native shell's account commands (`epicenter-account`).
 *
 * Key behaviors:
 * - The state is what the shell writes in `account.json`: signed out,
 *   signed in, or refused (reauth); a read before the settings connected
 *   throws, so nothing shows a stand-in
 * - The same person keeps the Account; another person, or signing out,
 *   retires it; signing in and out ask the shell, which writes the identity
 * - The account's fetch goes through the shell to the deployment only, and
 *   streams the answer back; a refusal, an abort, and a bodiless status each
 *   end it the way `fetch` would
 */
import { describe, expect, test } from 'bun:test';
import { createSettings, SettingsNotOpen } from '@epicenter/local/settings';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createTauriAuth, relayFetch, type TauriShell } from './tauri.js';

const ORIGIN = 'https://api.epicenter.so';
const PERSON = { origin: ORIGIN, principalId: 'person-1' };

type Sent = { command: string; args?: Record<string, unknown> };
type Listener = (message: unknown) => void;

/** A shell that answers each command with `answer`, recording what was sent. */
function shell(
	answer: (command: string, args?: Record<string, unknown>) => unknown,
) {
	const sent: Sent[] = [];
	const fake: TauriShell = {
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

/** This computer's settings in memory, holding `account.json` as the shell writes it. */
async function identityOf(initial: unknown) {
	let text: string | null =
		initial === null ? null : JSON.stringify(initial);
	let heard: ((names: readonly string[]) => void) | undefined;
	const settings = createSettings({
		async watch(changed) {
			heard = changed;
			return () => {};
		},
		read: async () => text,
		async write() {},
	});
	const identity = settings.file('account.json');
	await identity.connected();
	return {
		identity,
		/** The shell writes who is signed in, and the page hears it. */
		async write(next: unknown) {
			text = JSON.stringify(next);
			heard?.(['account.json']);
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
	};
}

/** Send `messages` on the channel a relay's fetch was given, in order. */
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
	test('is what the shell wrote, refused included', async () => {
		for (const [written, status] of [
			[null, 'signed-out'],
			[{ origin: ORIGIN, principalId: null, refused: false }, 'signed-out'],
			[{ ...PERSON, refused: false }, 'signed-in'],
			[{ ...PERSON, refused: true }, 'reauth-required'],
		] as const) {
			const { identity } = await identityOf(written);
			const client = createTauriAuth({ shell: shell(() => null).fake, identity });
			const state = client.state();
			expect(state.status).toBe(status);
			if (written !== null) expect(client.baseURL).toBe(ORIGIN);
			if (state.status !== 'signed-out') {
				expect(String(state.account.principalId)).toBe('person-1');
				expect(state.account.baseURL).toBe(ORIGIN);
			}
		}
	});

	test('a read before the settings connected throws, never a stand-in', () => {
		const settings = createSettings({
			watch: () => new Promise(() => {}),
			read: async () => null,
			async write() {},
		});
		const client = createTauriAuth({
			shell: shell(() => null).fake,
			identity: settings.file('account.json'),
		});
		expect(() => client.state()).toThrow(SettingsNotOpen);
	});
});

describe('signing in and out', () => {
	test('the same person keeps the Account; another retires it', async () => {
		const { identity, write } = await identityOf({ ...PERSON, refused: true });
		const { fake, sent } = shell(() => PERSON);
		const client = createTauriAuth({ shell: fake, identity });
		const seen: string[] = [];
		client.subscribe(() => seen.push(client.state().status));
		const first = client.state().account;
		expectOk(await client.startSignIn());
		expect(sent.map(({ command }) => command)).toEqual(['account_sign_in']);
		await write({ ...PERSON, refused: false });
		expect(client.state().status).toBe('signed-in');
		expect(client.state().account).toBe(first);
		await write({ origin: ORIGIN, principalId: 'person-2', refused: false });
		expect(first?.signal.aborted).toBe(true);
		expect(String(client.state().account?.principalId)).toBe('person-2');
		expect(seen).toEqual(['signed-in', 'signed-in']);
	});

	test('a sign-in that failed says so and changes nothing', async () => {
		const { identity } = await identityOf(null);
		const { fake } = shell(() =>
			new Error('The browser did not come back within ten minutes.'),
		);
		const client = createTauriAuth({ shell: fake, identity });
		const error = expectErr(await client.startSignIn());
		expect(error.name).toBe('StartSignInFailed');
		expect(error.message).toContain('ten minutes');
		expect(client.state().status).toBe('signed-out');
	});

	test('signing out asks the shell, and the identity it writes retires the Account', async () => {
		const { identity, write } = await identityOf({ ...PERSON, refused: false });
		const { fake, sent } = shell(() => null);
		const client = createTauriAuth({ shell: fake, identity });
		const account = client.state().account;
		expectOk(await client.signOut());
		expect(sent.map(({ command }) => command)).toContain('account_sign_out');
		await write({ origin: ORIGIN, principalId: null, refused: false });
		expect(client.state().status).toBe('signed-out');
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
		const { identity } = await identityOf({ ...PERSON, refused: false });
		const client = createTauriAuth({ shell: fake, identity });
		expect(expectOk(await client.getProfile()) as unknown).toEqual({
			id: 'person-1',
			email: 'a@b.c',
		});
	});
});
