/**
 * Native session ownership and process-generation isolation.
 *
 * Real core auth and handoff parsing run behind a controlled native port.
 * Cancellation settles before an opener acknowledgement; a failed relaunch
 * never gives an old window the replacement Account or its credential.
 */
import { expect, spyOn, test } from 'bun:test';
import { ApiSessionResponse, type AuthFetch } from '@epicenter/auth';
import { expectOk } from 'wellcrafted/testing';
import { createDesktopAuthAuthority } from './desktop-auth-authority.ts';

const STORED_CELL = JSON.stringify({ token: 'alice-1', principalId: 'alice' });

function setup({
	authCell = STORED_CELL,
	open,
	relaunch,
	fetch: fetchOverride,
	store,
}: {
	authCell?: string | null;
	open?: (url: string) => Promise<void>;
	relaunch?: () => void;
	fetch?: AuthFetch;
	store?: (serialized: string | null) => Promise<void>;
} = {}) {
	const writes: Array<string | null> = [];
	const events: string[] = [];
	const urls: string[] = [];
	const resources: string[] = [];
	const revoked: string[] = [];
	const completed = Promise.withResolvers<void>();
	let listener: ((url: string) => void) | undefined;
	const authority = createDesktopAuthAuthority({
		authCell,
		nativeAuthPort: {
			completed: completed.promise,
			async storeAuth(serialized) {
				await store?.(serialized);
				writes.push(serialized);
				events.push('stored');
			},
			async openAuthUrl(url) {
				urls.push(url);
				await open?.(url);
			},
			relaunch() {
				events.push('relaunch');
				relaunch?.();
			},
			onAuthCallback(next) {
				listener = next;
				return () => {
					listener = undefined;
					return true;
				};
			},
		},
		fetch:
			fetchOverride ??
			(async (input, init) => {
				const request = new Request(input, init);
				const url = new URL(request.url);
				if (url.pathname === '/auth/session/redeem') {
					const body = (await request.json()) as { code: string };
					return Response.json({ token: body.code });
				}
				const token = request.headers.get('authorization')?.slice(7) ?? '';
				if (url.pathname === '/api/session')
					return Response.json({
						principalId: token.startsWith('bob') ? 'bob' : 'alice',
					});
				if (url.pathname === '/auth/sign-out') {
					revoked.push(token);
					return new Response(null);
				}
				resources.push(token);
				return new Response('allowed');
			}),
	});
	return {
		authority,
		writes,
		events,
		urls,
		resources,
		revoked,
		completed,
		get listening() {
			return listener !== undefined;
		},
		callback(url: string) {
			listener?.(url);
		},
		finish(code = 'bob-1', index = urls.length - 1) {
			const state = new URL(urls[index]!).searchParams.get('state')!;
			listener?.(
				'epicenter://auth/callback?' + new URLSearchParams({ code, state }),
			);
		},
		[Symbol.dispose]() {
			authority[Symbol.dispose]();
		},
	};
}

async function until(check: () => boolean) {
	const end = Date.now() + 2_000;
	while (!check()) {
		if (Date.now() > end) throw new Error('Timed out waiting for native auth.');
		await Bun.sleep(1);
	}
}

test('a stored session boots offline and authorizes after verification without exposing the token', async () => {
	using context = setup();
	expect(context.authority.bootSnapshot.state).toEqual({
		status: 'signed-in',
		principalId: ApiSessionResponse.assert({ principalId: 'alice' })
			.principalId,
	});
	expect(context.authority.bootSnapshot.connection).toEqual({
		authorityId: 'epicenter-api',
		baseURL: 'https://api.epicenter.so',
		status: 'connected',
	});
	expect(JSON.stringify(context.authority.bootSnapshot)).not.toContain(
		'alice-1',
	);
	expect(
		String(expectOk(await context.authority.account!.getProfile()).id),
	).toBe('alice');
});

test('sign-out clears native storage before requesting relaunch', async () => {
	using context = setup();
	expectOk(await context.authority.signOut());
	expect(context.writes).toEqual([null]);
	expect(context.events).toEqual(['stored', 'relaunch']);
	expect(context.authority.state).toEqual({ status: 'signed-out' });
});

test('sign-out waits for revocation completion before native relaunch', async () => {
	const requested = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let responseReturned = false;
	using context = setup({
		async fetch(input, init) {
			const request = new Request(input, init);
			expect(new URL(request.url).pathname).toBe('/auth/sign-out');
			expect(request.headers.get('authorization')).toBe('Bearer alice-1');
			requested.resolve();
			await release.promise;
			responseReturned = true;
			return new Response(null);
		},
	});
	const signingOut = context.authority.signOut();
	try {
		await requested.promise;
		await until(() => context.writes.length === 1);
		// Allow the native continuation to run while the HTTP response is held.
		await Bun.sleep(0);
		expect(context.authority.state).toEqual({ status: 'signed-out' });
		expect(context.writes).toEqual([null]);
		expect(responseReturned).toBe(false);
		expect(context.events).toEqual(['stored']);
	} finally {
		release.resolve();
		await signingOut;
	}
	expectOk(await signingOut);
	expect(responseReturned).toBe(true);
	expect(context.events).toEqual(['stored', 'relaunch']);
});

test('unreadable and obsolete OAuth cells boot signed-out', () => {
	for (const authCell of [
		'not-json',
		'{"deployment":{"kind":"self-hosted"}}',
		JSON.stringify({
			grant: {
				accessToken: 'old',
				refreshToken: 'old',
				accessTokenExpiresAt: 9999999999999,
			},
			principalId: 'alice',
		}),
	]) {
		using context = setup({ authCell });
		expect(context.authority.bootSnapshot.state).toEqual({
			status: 'signed-out',
		});
		expect(context.authority.account).toBeNull();
	}
});

test('duplicate sign-in calls register before the opener and persist before one relaunch', async () => {
	let callback: ((url: string) => void) | undefined;
	using context = setup({
		open: async (url) => {
			const state = new URL(url).searchParams.get('state')!;
			callback?.(
				'epicenter://auth/callback?' +
					new URLSearchParams({ code: 'alice-2', state }),
			);
		},
	});
	callback = context.callback;
	const account = context.authority.account;
	const first = context.authority.startSignIn();
	expect(context.authority.startSignIn()).toBe(first);
	expectOk(await first);
	expect(context.urls).toHaveLength(1);
	expect(new URL(context.urls[0]!).pathname).toBe('/sign-in');
	expect(context.events).toEqual(['stored', 'relaunch']);
	expect(JSON.parse(context.writes[0]!)).toEqual({
		token: 'alice-2',
		principalId: 'alice',
	});
	expect(context.authority.account).toBe(account);
	await account!.fetch('/api/example');
	expect(context.resources).toEqual(['alice-2']);
});

test('failed relaunch after replacement leaves the captured boot Account permanently rejected', async () => {
	using context = setup({
		relaunch() {
			throw new Error('relaunch failed');
		},
	});
	const boot = context.authority.account!;
	const pending = context.authority.startSignIn();
	await until(() => context.urls.length === 1);
	context.finish('bob-1');
	await expect(pending).rejects.toThrow('relaunch failed');
	expect(context.authority.account).toBe(boot);
	expect(context.authority.state).toEqual({ status: 'signed-out' });
	expect(context.authority.bootSnapshot.state).toEqual({
		status: 'signed-in',
		principalId: ApiSessionResponse.assert({ principalId: 'alice' })
			.principalId,
	});
	expect(JSON.parse(context.writes.at(-1)!)).toEqual({
		token: 'bob-1',
		principalId: 'bob',
	});
	await expect(boot.fetch('/api/example')).rejects.toBeDefined();
	expect(context.resources).toEqual([]);
});

test('a signed-out boot never acquires an Account when sign-in cannot relaunch', async () => {
	using context = setup({
		authCell: null,
		relaunch() {
			throw new Error('relaunch failed');
		},
	});
	const pending = context.authority.startSignIn();
	await until(() => context.urls.length === 1);
	context.finish();
	await expect(pending).rejects.toThrow('relaunch failed');
	expect(context.authority.account).toBeNull();
	expect(context.authority.state).toEqual({ status: 'signed-out' });
	expect(context.authority.bootSnapshot.state).toEqual({
		status: 'signed-out',
	});
});

for (const action of ['sign-out', 'dispose', 'native-close'] as const) {
	test(
		action +
			' settles a pending callback without waiting for the opener acknowledgement',
		async () => {
			const opener = Promise.withResolvers<void>();
			using context = setup({ open: () => opener.promise });
			const pending = context.authority.startSignIn();
			await until(() => context.urls.length === 1);
			if (action === 'sign-out') expectOk(await context.authority.signOut());
			else if (action === 'dispose') context.authority[Symbol.dispose]();
			else context.completed.resolve();
			expect((await pending).error).not.toBeNull();
			context.finish();
			opener.resolve();
			await Bun.sleep(0);
			expect(context.writes).toEqual(action === 'sign-out' ? [null] : []);
			expect(
				context.events.filter((event) => event === 'relaunch'),
			).toHaveLength(action === 'sign-out' ? 1 : 0);
			if (action !== 'sign-out') expect(context.listening).toBe(false);
		},
	);
}

test('timeout clears the waiter and a later attempt cannot consume its callback', async () => {
	const original = globalThis.setTimeout;
	const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
		...[handler, delay, ...args]: Parameters<typeof setTimeout>
	) =>
		original(
			handler,
			delay === 600_000 ? 5 : delay,
			...args,
		)) as typeof setTimeout);
	try {
		using context = setup();
		expect((await context.authority.startSignIn()).error).not.toBeNull();
		timer.mockRestore();
		context.finish();
		const next = context.authority.startSignIn();
		await until(() => context.urls.length === 2);
		context.finish('alice-2');
		expectOk(await next);
		expect(context.events).toEqual(['stored', 'relaunch']);
	} finally {
		timer.mockRestore();
	}
});

test('an opener failure clears the attempt and does not persist or relaunch', async () => {
	using context = setup({
		async open() {
			throw new Error('browser unavailable');
		},
	});
	expect((await context.authority.startSignIn()).error).not.toBeNull();
	context.finish();
	expect(context.writes).toEqual([]);
	expect(context.events).toEqual([]);
});

test('an unsolicited or wrong-state callback never installs an account', async () => {
	using context = setup();
	context.callback('epicenter://auth/callback?code=bob-1&state=unsolicited');
	const pending = context.authority.startSignIn();
	await until(() => context.urls.length === 1);
	context.callback('epicenter://auth/callback?code=bob-1&state=wrong');
	expect((await pending).error).not.toBeNull();
	expect(context.writes).toEqual([]);
	expect(context.events).toEqual([]);
});

test('native persistence failure prevents relaunch and leaves the boot Account selected', async () => {
	using context = setup({
		async store() {
			throw new Error('keychain unavailable');
		},
	});
	const boot = context.authority.account;
	const pending = context.authority.startSignIn();
	await until(() => context.urls.length === 1);
	context.finish('bob-1');
	expect((await pending).error).not.toBeNull();
	expect(context.authority.account).toBe(boot);
	expect(context.events).toEqual([]);
	await until(() => context.revoked.includes('bob-1'));
});

test('a cancelled redemption cannot overwrite a later sign-in or request another relaunch', async () => {
	const redeemed = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const revoked: string[] = [];
	using context = setup({
		async fetch(input, init) {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			if (path === '/auth/session/redeem') {
				const { code } = (await request.json()) as { code: string };
				if (code === 'orphan') {
					redeemed.resolve();
					await release.promise;
				}
				return Response.json({ token: code });
			}
			const token = request.headers.get('authorization')?.slice(7) ?? '';
			if (path === '/auth/sign-out') {
				revoked.push(token);
				return new Response(null);
			}
			if (path === '/api/session')
				return Response.json({
					principalId: token === 'bob-2' ? 'bob' : 'alice',
				});
			throw new Error('Unexpected native auth request');
		},
	});
	const old = context.authority.startSignIn();
	await until(() => context.urls.length === 1);
	context.finish('orphan');
	await redeemed.promise;
	expectOk(await context.authority.signOut());
	expect((await old).error).not.toBeNull();
	const current = context.authority.startSignIn();
	await until(() => context.urls.length === 2);
	context.finish('bob-2');
	expectOk(await current);
	release.resolve();
	await until(() => revoked.includes('orphan'));
	expect(context.writes).toEqual([
		null,
		JSON.stringify({ token: 'bob-2', principalId: 'bob' }),
	]);
	expect(context.events.filter((event) => event === 'relaunch')).toHaveLength(
		2,
	);
	expect(revoked).not.toContain('bob-2');
});
