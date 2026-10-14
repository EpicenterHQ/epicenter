import { describe, expect, test } from 'bun:test';
import type { Account, AuthClient, AuthState } from '@epicenter/auth';
import { createGitAccess } from './git-access.js';

const SERVER = 'https://api.example.test';
const REMOTE = `${SERVER}/git/so.epicenter.todos.0123456789abcdef.git`;
const signal = new AbortController().signal;

/** An auth client whose account answers `/api/git/connect` with `answer`. */
function fakeAuth(answer: (call: number) => Response | Promise<Response>) {
	const listeners = new Set<(state: AuthState) => void>();
	let calls = 0;
	const requests: Request[] = [];
	const account = {
		authorityId: 'epicenter-api',
		principalId: 'user-1',
		baseURL: SERVER,
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(new Request(input, init));
			return answer(++calls);
		},
		getProfile: async () => {
			throw new Error('unused');
		},
	} as unknown as Account;
	let state: AuthState = { status: 'signed-in', account };
	const auth = {
		baseURL: SERVER,
		getState: () => state,
		onStateChange: (listener: (next: AuthState) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as AuthClient;
	return {
		auth,
		requests,
		calls: () => calls,
		set(next: AuthState) {
			state = next;
			for (const listener of listeners) listener(next);
		},
	};
}

const connected = (token: string, expiresIn = 3600, remote = REMOTE) =>
	Response.json({ remote, token, expiresAt: '2099-01-01T00:00:00Z', expiresIn });

function memoryStorage() {
	const items = new Map<string, string>();
	return {
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => void items.set(key, value),
		removeItem: (key: string) => void items.delete(key),
	};
}

describe('Epicenter remotes', () => {
	test('connect asks for the todos folder and keeps the token for exactly that remote', async () => {
		const server = fakeAuth(() => connected('t1'));
		const access = createGitAccess({
			auth: server.auth,
			storage: memoryStorage(),
			now: () => Date.parse('2026-10-14T12:00:00Z'),
		});
		expect((await access.connectEpicenter()).data).toBe(REMOTE);
		const [request] = server.requests;
		expect(request?.url).toBe(`${SERVER}/api/git/connect`);
		expect(request?.method).toBe('POST');
		expect(await request?.json()).toEqual({ folder: 'so.epicenter.todos' });
		expect(await access.credentials(REMOTE, signal)).toEqual({
			username: 'x-token',
			password: 't1',
		});
		// Cached: no second connect while the token has time left.
		expect(server.calls()).toBe(1);
	});

	test('a token close to expiry is renewed before it is used', async () => {
		let time = Date.parse('2026-10-14T12:00:00Z');
		// The device clock is far off; renewal follows the server's expiresIn.
		const server = fakeAuth((call) => connected(`t${call}`, 3600));
		const access = createGitAccess({ auth: server.auth, storage: memoryStorage(), now: () => time });
		expect((await access.credentials(REMOTE, signal))?.password).toBe('t1');
		time += 56 * 60_000;
		expect((await access.credentials(REMOTE, signal))?.password).toBe('t2');
		expect(server.calls()).toBe(2);
	});

	test('signing out drops the token and refuses the transfer instead of sending none', async () => {
		const server = fakeAuth(() => connected('t1'));
		const access = createGitAccess({ auth: server.auth, storage: memoryStorage() });
		await access.connectEpicenter();
		server.set({ status: 'signed-out' });
		await expect(access.credentials(REMOTE, signal)).rejects.toThrow('Sign in to Epicenter');
		expect((await access.connectEpicenter()).error?.name).toBe('SignInRequired');
	});

	test('a sign-out while a token is renewed refuses the transfer instead of sending none', async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const server = fakeAuth(async () => {
			await held;
			return connected('t1');
		});
		const access = createGitAccess({ auth: server.auth, storage: memoryStorage() });
		const asked = access.credentials(REMOTE, signal);
		server.set({ status: 'signed-out' });
		release();
		await expect(asked).rejects.toThrow('Sign in to Epicenter');
	});

	test('once this account knows its repository, another one is refused without asking the server', async () => {
		const server = fakeAuth(() => connected('t1'));
		const access = createGitAccess({ auth: server.auth, storage: memoryStorage() });
		await access.connectEpicenter();
		const other = `${SERVER}/git/so.epicenter.todos.ffffffffffffffff.git`;
		await expect(access.credentials(other, signal)).rejects.toThrow('does not own');
		expect(server.calls()).toBe(1);
		expect(access.isEpicenter(other)).toBe(true);
		expect(access.isEpicenter('https://elsewhere.test/git/x.git')).toBe(false);
	});

	test("another account's repository gets no token", async () => {
		const mine = `${SERVER}/git/so.epicenter.todos.ffffffffffffffff.git`;
		const server = fakeAuth(() => connected('t1', 3600, mine));
		const access = createGitAccess({ auth: server.auth, storage: memoryStorage() });
		await expect(access.credentials(REMOTE, signal)).rejects.toThrow(
			'does not own',
		);
	});

	test('a refusal and an answer Todos cannot read are named', async () => {
		const unavailable = fakeAuth(() =>
			Response.json({ name: 'GitUnavailable', message: 'no store' }, { status: 503 }),
		);
		expect(
			(await createGitAccess({ auth: unavailable.auth, storage: memoryStorage() }).connectEpicenter())
				.error?.message,
		).toContain('does not keep todos');
		const elsewhere = fakeAuth(() =>
			connected('t1', 3600, 'https://evil.test/git/x.git'),
		);
		expect(
			(await createGitAccess({ auth: elsewhere.auth, storage: memoryStorage() }).connectEpicenter())
				.error?.name,
		).toBe('Malformed');
	});
});

describe('other remotes', () => {
	test('a pasted token goes to its exact URL only, and nothing goes elsewhere', async () => {
		const server = fakeAuth(() => {
			throw new Error('no connect for other servers');
		});
		const storage = memoryStorage();
		const access = createGitAccess({ auth: server.auth, storage });
		const forgejo = 'https://git.example.com/me/todos.git';
		access.remember(forgejo, { username: 'me', password: 'pat' });
		expect(await access.credentials(forgejo, signal)).toEqual({ username: 'me', password: 'pat' });
		expect(await access.credentials('https://git.example.com/me/other.git', signal)).toBeUndefined();
		expect(await access.credentials('https://github.com/me/todos.git', signal)).toBeUndefined();
		// A path outside `/git/` on Epicenter's server is not Epicenter's remote.
		expect(await access.credentials(`${SERVER}/elsewhere.git`, signal)).toBeUndefined();
		// Kept on this device, and forgotten on request.
		await expect(createGitAccess({ auth: server.auth, storage }).credentials(forgejo, signal)).resolves.toEqual({
			username: 'me',
			password: 'pat',
		});
		access.remember(forgejo, undefined);
		expect(await access.credentials(forgejo, signal)).toBeUndefined();
		expect(server.calls()).toBe(0);
	});
});
