/**
 * Native session ownership and process-generation isolation.
 *
 * Real core auth and handoff parsing run behind a controlled native port.
 * Cancellation settles before an opener acknowledgement; a failed relaunch
 * never gives an old window the replacement Account or its credential.
 */
import { expect, spyOn, test } from 'bun:test';
import { ApiSessionResponse, type AuthFetch } from '@epicenter/auth';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createDesktopAuthAuthority } from './desktop-auth-authority.ts';

const STORED_CELL = JSON.stringify({
	method: 'cloud',
	origin: 'https://api.epicenter.so',
	auth: { token: 'alice-1', principalId: 'alice' },
});

function setup({
	authCell = STORED_CELL,
	open,
	relaunch,
	fetch: fetchOverride,
	store,
	closeApplications,
	resumeApplications,
	callbackUrl,
}: {
	authCell?: string | null;
	closeApplications?: () => Promise<void>;
	resumeApplications?: () => Promise<void>;
	callbackUrl?: string;
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
		callbackUrl,
		nativeAuthPort: {
			async closeApplications() {
				await closeApplications?.();
			},
			async resumeApplications() {
				await resumeApplications?.();
			},
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

test('cancelling browser sign-in preserves the boot Account and releases application launching', async () => {
	let resumed = 0;
	using context = setup({
		resumeApplications: async () => {
			resumed++;
		},
	});
	const account = context.authority.account;
	const pending = context.authority.startSignIn();
	await until(() => context.urls.length === 1);
	expectOk(await context.authority.cancelConnection());
	expectErr(await pending);
	context.finish();
	await Bun.sleep(0);
	expect(context.authority.account).toBe(account);
	expect(context.authority.getState().status).toBe('signed-in');
	expect(context.writes).toEqual([]);
	expect(resumed).toBe(1);
	expect(context.events).not.toContain('relaunch');
});

test('cancelling during application close waits for the barrier and never opens the browser', async () => {
	const closed = Promise.withResolvers<void>();
	let resumed = 0;
	using context = setup({
		closeApplications: () => closed.promise,
		resumeApplications: async () => {
			resumed++;
		},
	});
	const pending = context.authority.startSignIn();
	await Bun.sleep(0);
	const cancelled = context.authority.cancelConnection();
	closed.resolve();
	expectOk(await cancelled);
	expectErr(await pending);
	expect(context.urls).toEqual([]);
	expect(context.writes).toEqual([]);
	expect(resumed).toBe(1);
});

test('development accepts only its configured loopback callback and pending state', async () => {
	const callbackUrl = 'http://127.0.0.1:49152/_epicenter/sign-in/callback';
	using context = setup({ callbackUrl });
	const pending = context.authority.startSignIn();
	await until(() => context.urls.length === 1);
	const launch = new URL(context.urls[0]!);
	expect(launch.searchParams.get('callback')).toBe(callbackUrl);
	const params = new URLSearchParams({
		code: 'alice-2',
		state: launch.searchParams.get('state')!,
	});
	expect(
		context.authority.acceptSignInCallback(
			`epicenter://auth/callback?${params}`,
		),
	).toBe(false);
	expect(
		context.authority.acceptSignInCallback(
			`${callbackUrl}?code=alice-2&state=wrong`,
		),
	).toBe(false);
	expect(
		context.authority.acceptSignInCallback(`${callbackUrl}?${params}`),
	).toBe(true);
	expectOk(await pending);
	expect(
		context.authority.acceptSignInCallback(`${callbackUrl}?${params}`),
	).toBe(false);
});

test('cancellation waits for a credential write to roll back before reopening applications', async () => {
	const saving = Promise.withResolvers<void>();
	const saved = Promise.withResolvers<void>();
	let resumed = false;
	using context = setup({
		async store(value) {
			if (value?.includes('alice-2')) {
				saving.resolve();
				await saved.promise;
			}
		},
		async resumeApplications() {
			resumed = true;
		},
	});
	const account = context.authority.account;
	const pending = context.authority.startSignIn();
	await until(() => context.urls.length === 1);
	context.finish('alice-2');
	await saving.promise;
	const cancellation = context.authority.cancelConnection();
	await Bun.sleep(0);
	expect(resumed).toBe(false);
	saved.resolve();
	expectOk(await cancellation);
	expectErr(await pending);
	expect(context.writes.at(-1)).toBe(STORED_CELL);
	expect(context.authority.account).toBe(account);
	expect(resumed).toBe(true);
});

test('repeated cancellation cannot reopen applications until a failed rollback is repaired', async () => {
	const saving = Promise.withResolvers<void>();
	const saved = Promise.withResolvers<void>();
	let failRestoration = true;
	let resumed = false;
	using context = setup({
		async store(value) {
			if (value?.includes('alice-2')) {
				saving.resolve();
				await saved.promise;
			} else if (value === STORED_CELL && failRestoration) {
				throw new Error('Keychain unavailable during rollback');
			}
		},
		async resumeApplications() {
			resumed = true;
		},
	});
	const pending = context.authority.startSignIn();
	await until(() => context.urls.length === 1);
	context.finish('alice-2');
	await saving.promise;
	const cancellation = context.authority.cancelConnection();
	await Bun.sleep(0);
	saved.resolve();
	expectErr(await cancellation);
	expectErr(await pending);
	expectErr(await context.authority.cancelConnection());
	expect(resumed).toBe(false);
	failRestoration = false;
	expectOk(await context.authority.cancelConnection());
	expect(context.writes.at(-1)).toBe(STORED_CELL);
	expect(resumed).toBe(true);
});

test('a stored session boots offline and authorizes after verification without exposing the token', async () => {
	using context = setup();
	expect(context.authority.bootSnapshot.state).toEqual({
		status: 'signed-in',
		principalId: ApiSessionResponse.assert({ principalId: 'alice' })
			.principalId,
	});
	expect(context.authority.bootSnapshot).toMatchObject({
		baseURL: 'https://api.epicenter.so',
		authorityId: 'epicenter-api',
		startSignIn: true,
		accountManagement: true,
		recovery: false,
		selectedServer: null,
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
	expect(context.authority.getState()).toEqual({ status: 'signed-out' });
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
		expect(context.authority.getState()).toEqual({ status: 'signed-out' });
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

test('unsafe native cells enter recovery without exposing identity, requests, or changing saved bytes', async () => {
	for (const authCell of [
		'not-json',
		JSON.stringify({
			method: 'issuer',
			origin: 'https://api.epicenter.so',
			auth: { token: 'alice-1', principalId: 'alice' },
		}),
		'null',
		JSON.stringify({ token: 'alice-1', principalId: 'alice' }),
		JSON.stringify({
			method: 'cloud',
			origin: 'https://other.example',
			auth: { token: 'alice-1', principalId: 'alice' },
		}),
		JSON.stringify({
			method: 'instance',
			origin: 'https://instance.example/',
			auth: null,
		}),
		JSON.stringify({ method: 'instance', origin: 'invalid', auth: null }),
		JSON.stringify({
			method: 'instance',
			origin: 'https://instance.example',
			auth: { token: '', principalId: 'instance' },
		}),
		JSON.stringify({
			method: 'instance',
			origin: 'https://instance.example',
			auth: { token: 'operator', principalId: 'alice' },
		}),
		JSON.stringify({ method: 'cloud', origin: 'https://api.epicenter.so' }),
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
		let requests = 0;
		using context = setup({
			authCell,
			fetch: async () => {
				requests++;
				throw new Error('Unsafe cell must not make requests.');
			},
		});
		expect(context.authority.bootSnapshot.state).toEqual({
			status: 'signed-out',
		});
		expect(context.authority.account).toBeNull();
		expect(context.authority.bootSnapshot.recovery).toBe(true);
		expect((await context.authority.startSignIn()).error).not.toBeNull();
		expectOk(await context.authority.cancelConnection());
		expect(context.writes).toEqual([]);
		expect(requests).toBe(0);
	}
});

test('deliberate Cloud selection leaves recovery through a fresh process without revoking the unsafe token', async () => {
	using context = setup({
		authCell: JSON.stringify({ token: 'unsafe', principalId: 'alice' }),
		fetch: async () => {
			throw new Error('No revocation is permitted.');
		},
	});
	expectOk(await context.authority.useCloud());
	expect(context.writes).toEqual([null]);
	expect(context.events).toEqual(['stored', 'relaunch']);
	expect(context.authority.account).toBeNull();
	expect(context.authority.bootSnapshot.recovery).toBe(true);
});

test('forced reauthentication reaches the native hosted handoff without preliminary sign-out', async () => {
	using context = setup();
	const account = context.authority.account;
	const signingIn = context.authority.startSignIn({ reauthenticate: true });
	await until(() => context.urls.length === 1);
	expect(new URL(context.urls[0]!).searchParams.get('reauth')).toBe('1');
	expect(context.writes).toEqual([]);
	expect(context.revoked).toEqual([]);
	context.finish('alice-2');
	expectOk(await signingIn);
	expect(context.authority.account).toBe(account);
});

test('duplicate same-owner sign-in calls persist once and retain the boot Account', async () => {
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
	expect(context.events).toEqual(['stored']);
	expect(JSON.parse(context.writes[0]!).auth).toEqual({
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
	expect((await pending).error).not.toBeNull();
	expect(context.authority.account).toBe(boot);
	expect(context.authority.getState()).toEqual({ status: 'signed-out' });
	expect(context.authority.bootSnapshot.state).toEqual({
		status: 'signed-in',
		principalId: ApiSessionResponse.assert({ principalId: 'alice' })
			.principalId,
	});
	expect(JSON.parse(context.writes.at(-1)!).auth).toEqual({
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
	expect((await pending).error).not.toBeNull();
	expect(context.authority.account).toBeNull();
	expect(context.authority.getState()).toEqual({ status: 'signed-out' });
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
		expect(context.events).toEqual(['stored']);
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

test('an unsolicited or wrong-state callback cannot consume the pending sign-in', async () => {
	using context = setup();
	context.callback('epicenter://auth/callback?code=bob-1&state=unsolicited');
	const pending = context.authority.startSignIn();
	await until(() => context.urls.length === 1);
	context.callback('epicenter://auth/callback?code=bob-1&state=wrong');
	await Bun.sleep(0);
	expect(context.writes).toEqual([]);
	expect(context.events).toEqual([]);
	context.finish('alice-2');
	expectOk(await pending);
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

test.each([
	'sign-out',
	'cancel',
] as const)('%s during redemption revokes a late result without overwriting the next sign-in', async (action) => {
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
	const account = context.authority.account;
	if (action === 'cancel') expectOk(await context.authority.cancelConnection());
	else expectOk(await context.authority.signOut());
	expect((await old).error).not.toBeNull();
	expect(context.authority.account).toBe(account);
	expect(context.authority.getState().status).toBe(
		action === 'cancel' ? 'signed-in' : 'signed-out',
	);
	const current = context.authority.startSignIn();
	await until(() => context.urls.length === 2);
	context.finish('bob-2');
	expectOk(await current);
	release.resolve();
	await until(() => revoked.includes('orphan'));
	expect(context.writes).toEqual([
		null,
		JSON.stringify({
			method: 'cloud',
			origin: 'https://api.epicenter.so',
			auth: { token: 'bob-2', principalId: 'bob' },
		}),
	]);
	expect(context.events.filter((event) => event === 'relaunch')).toHaveLength(
		action === 'cancel' ? 1 : 2,
	);
	expect(revoked).not.toContain('bob-2');
});

test('issuer selection persists one empty cell and retires the captured boot Account', async () => {
	using context = setup();
	const boot = context.authority.account!;
	expectOk(await context.authority.connectInstance('http://LOCALHOST:8788/'));
	expect(context.writes.map((cell) => JSON.parse(cell!))).toEqual([
		null,
		{ method: 'issuer', origin: 'http://localhost:8788', auth: null },
	]);
	expect(context.events).toEqual(['stored', 'stored', 'relaunch']);
	expect(context.authority.baseURL).toBe('https://api.epicenter.so');
	expect(context.authority.account).toBe(boot);
	await expect(boot.fetch('/api/example')).rejects.toBeDefined();
	expect(context.urls).toEqual([]);
});

test('an instance boots offline with its own identity and disconnects without hosted revocation', async () => {
	using context = setup({
		authCell: JSON.stringify({
			method: 'instance',
			origin: 'http://localhost:8788',
			auth: { token: 'operator', principalId: 'instance' },
		}),
		fetch: async () => {
			throw new Error('Disconnect must not make requests.');
		},
	});
	expect(context.authority.account!.authorityId).toStartWith('instance-');
	expect(context.authority.bootSnapshot.authorityId).toBe(
		context.authority.account!.authorityId!,
	);
	expect(context.authority.baseURL).toBe('http://localhost:8788');
	expect(context.authority.bootSnapshot.startSignIn).toBe(false);
	expectOk(await context.authority.signOut());
	expect(context.writes).toEqual([
		JSON.stringify({
			method: 'instance',
			origin: 'http://localhost:8788',
			auth: null,
		}),
	]);
	expect(context.events).toEqual(['stored', 'relaunch']);
});

test('the configured Cloud origin cannot be selected as a custom issuer', async () => {
	using context = setup();
	const boot = context.authority.account;
	const result = await context.authority.connectInstance(
		'https://API.epicenter.so/',
	);
	expect(result.error).not.toBeNull();
	expect(result.error?.message).toContain(
		'Use Epicenter Cloud to connect to this server.',
	);
	expect(context.writes).toEqual([]);
	expect(context.events).toEqual([]);
	expect(context.revoked).toEqual([]);
	expect(context.authority.account).toBe(boot);
	expect(context.authority.getState().status).toBe('signed-in');
});

test('sign-out cancels issuer selection while the native close barrier is pending', async () => {
	const requested = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	using context = setup({
		authCell: null,
		closeApplications: async () => {
			requested.resolve();
			await release.promise;
		},
	});
	const connecting = context.authority.connectInstance(
		'https://my-server.example',
	);
	await requested.promise;
	const disconnecting = context.authority.signOut();
	release.resolve();
	expect((await connecting).error).not.toBeNull();
	expectOk(await disconnecting);
	expect(context.writes).toEqual([null]);
	expect(context.events).toEqual(['stored', 'relaunch']);
});

test('cancelling an issuer commit leaves the original server signed out', async () => {
	const writing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let first = true;
	using context = setup({
		store: async (cell) => {
			if (cell !== null && first) {
				first = false;
				writing.resolve();
				await release.promise;
			}
		},
	});

	const connecting = context.authority.connectInstance(
		'https://my-server.example',
	);
	await writing.promise;
	context.authority[Symbol.dispose]();
	release.resolve();
	expect((await connecting).error).not.toBeNull();
	await until(() => context.writes.length === 3);
	expect(context.writes.at(-1)).toBeNull();
	expect(context.events).not.toContain('relaunch');
});

test('disconnect during hosted release cancels selection and does not reconnect', async () => {
	const revoking = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	using context = setup({
		fetch: async (input) => {
			if (new URL(String(input)).pathname === '/auth/sign-out') {
				revoking.resolve();
				await release.promise;
				return new Response(null);
			}
			throw new Error('Selection must not contact the candidate issuer.');
		},
	});

	const connecting = context.authority.connectInstance(
		'https://my-server.example',
	);
	await revoking.promise;
	const disconnecting = context.authority.signOut();
	await until(() => context.writes.length === 2);
	release.resolve();
	await connecting;
	expectOk(await disconnecting);
	expect(context.writes.at(-1)).toBeNull();
	expect(context.events.filter((event) => event === 'relaunch')).toHaveLength(
		1,
	);
});

for (const target of ['issuer', 'hosted'] as const) {
	test(`${target} selection drains an outstanding old principal-mismatch write before saving the next boot`, async () => {
		const oldResponse = Promise.withResolvers<Response>();
		const oldRequested = Promise.withResolvers<void>();
		const clearing = Promise.withResolvers<void>();
		const releaseClear = Promise.withResolvers<void>();
		let firstClear = true;
		using context = setup({
			authCell: JSON.stringify({
				method: 'instance',
				origin: 'https://old.example',
				auth: { token: 'old', principalId: 'instance' },
			}),
			fetch: async (input) => {
				if (new URL(String(input)).origin === 'https://old.example') {
					oldRequested.resolve();
					return oldResponse.promise;
				}
				throw new Error('Selection must not contact the candidate issuer.');
			},
			store: async (cell) => {
				if (cell !== null && JSON.parse(cell).auth === null && firstClear) {
					firstClear = false;
					clearing.resolve();
					await releaseClear.promise;
				}
			},
		});
		const oldRequest = context.authority
			.account!.fetch('/api/example')
			.catch(() => undefined);
		await oldRequested.promise;
		oldResponse.resolve(Response.json({ principalId: 'different-person' }));
		await clearing.promise;

		const selecting =
			target === 'issuer'
				? context.authority.connectInstance('https://new.example')
				: context.authority.useCloud();
		await Bun.sleep(0);
		expect(context.writes).toEqual([]);
		expect(context.events).not.toContain('relaunch');
		releaseClear.resolve();
		expectOk(await selecting);
		await oldRequest;
		expect(context.writes.map((cell) => JSON.parse(cell ?? 'null'))).toEqual([
			{ method: 'instance', origin: 'https://old.example', auth: null },
			{ method: 'instance', origin: 'https://old.example', auth: null },
			target === 'issuer'
				? {
						method: 'issuer',
						origin: 'https://new.example',
						auth: null,
					}
				: null,
		]);
		expect(context.events.at(-1)).toBe('relaunch');
	});
}

test('server selection owns and waits for the application close barrier', async () => {
	const closed = Promise.withResolvers<void>();
	using context = setup({
		authCell: JSON.stringify({
			method: 'issuer',
			origin: 'https://self.example',
			auth: { token: 'alice-1', principalId: 'alice' },
		}),
		closeApplications: () => closed.promise,
	});
	const selecting = context.authority.useCloud();
	await Bun.sleep(0);
	expect((await context.authority.useCloud()).error).not.toBeNull();
	expect(context.writes).toEqual([]);
	expect(context.authority.getState().status).toBe('signed-in');
	closed.resolve();
	expectOk(await selecting);
	expect(context.events.at(-1)).toBe('relaunch');
});

test('a failed application close refuses sign-out without changing credentials or relaunching', async () => {
	using context = setup({
		closeApplications: async () => {
			throw new Error('unsaved data');
		},
	});
	expect((await context.authority.signOut()).error).not.toBeNull();
	expect(context.writes).toEqual([]);
	expect(context.events).toEqual([]);
	expect(context.authority.getState().status).toBe('signed-in');
	expect((await context.authority.useCloud()).error).not.toBeNull();
});

test('ordinary sign-in waits for application close before opening the browser', async () => {
	const closed = Promise.withResolvers<void>();
	using context = setup({ closeApplications: () => closed.promise });
	const signingIn = context.authority.startSignIn();
	await Bun.sleep(0);
	expect(context.urls).toEqual([]);
	closed.resolve();
	await until(() => context.urls.length === 1);
	context.finish();
	expectOk(await signingIn);
});

test('selection remains blocked while the native launch gate is reopening', async () => {
	const resumed = Promise.withResolvers<void>();
	let closes = 0;
	using context = setup({
		authCell: JSON.stringify({
			method: 'issuer',
			origin: 'https://self.example',
			auth: { token: 'alice-1', principalId: 'alice' },
		}),
		closeApplications: async () => {
			closes++;
		},
		resumeApplications: () => resumed.promise,
	});

	const cancelling = context.authority.cancelConnection();
	expect(
		(await context.authority.connectInstance('https://example.com')).error,
	).not.toBeNull();
	expect((await context.authority.useCloud()).error).not.toBeNull();
	expect((await context.authority.startSignIn()).error).not.toBeNull();
	expect(context.writes).toEqual([]);
	expect(closes).toBe(0);
	resumed.resolve();
	expectOk(await cancelling);
	expectOk(await context.authority.useCloud());
	expect(closes).toBe(1);
});

for (const failure of ['candidate-save', 'old-sign-out'] as const) {
	test(`cancel after ${failure} failure restarts the original server signed out`, async () => {
		const originalServer = 'https://old.example';
		let fail = true;
		let resumed = false;
		using context = setup({
			authCell: JSON.stringify({
				method: 'instance',
				origin: originalServer,
				auth: { token: 'old', principalId: 'instance' },
			}),
			resumeApplications: async () => {
				resumed = true;
			},
			store: async (cell) => {
				const value = JSON.parse(cell ?? 'null');
				if (
					fail &&
					(failure === 'candidate-save'
						? value?.origin === 'https://new.example'
						: value?.auth === null)
				) {
					fail = false;
					throw new Error('native write failed');
				}
			},
		});

		expect(
			(await context.authority.connectInstance('https://new.example')).error,
		).not.toBeNull();
		expect(context.authority.getState().status).toBe('signed-out');
		expect(context.events).not.toContain('relaunch');
		expectOk(await context.authority.cancelConnection());
		expect(context.writes.at(-1)).toBe(
			JSON.stringify({
				method: 'instance',
				origin: originalServer,
				auth: null,
			}),
		);
		expect(resumed).toBe(false);
		expect(context.events.at(-1)).toBe('relaunch');
	});
}

test('failed cancellation clear never relaunches or reopens a retired boot', async () => {
	let resumed = false;
	using context = setup({
		store: async () => {
			throw new Error('native storage unavailable');
		},
		resumeApplications: async () => {
			resumed = true;
		},
	});

	expect(
		(await context.authority.connectInstance('https://new.example')).error,
	).not.toBeNull();
	expect((await context.authority.cancelConnection()).error).not.toBeNull();
	expect(context.events).toEqual([]);
	expect(resumed).toBe(false);
});

test('failed hosted replacement drains its persistence before recovering the original boot signed out', async () => {
	const clearing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let first = true;
	let resumed = false;
	using context = setup({
		resumeApplications: async () => {
			resumed = true;
		},
		store: async () => {
			if (first) {
				first = false;
				clearing.resolve();
				await release.promise;
				throw new Error('failed old identity clear');
			}
		},
	});
	const signingIn = context.authority.startSignIn();
	await until(() => context.urls.length === 1);
	context.finish('bob-2');
	await clearing.promise;
	expect(context.authority.getState().status).toBe('signed-out');
	expect(context.events).toEqual([]);
	expect(resumed).toBe(false);
	release.resolve();
	expect((await signingIn).error).not.toBeNull();
	expect(context.writes).toEqual([null]);
	expect(context.events).toEqual(['stored', 'relaunch']);
	expect(resumed).toBe(false);
});

test('URL-only selection persists a named issuer without treating the old static identity as its user', async () => {
	using context = setup({
		authCell: JSON.stringify({
			method: 'instance',
			origin: 'https://self.example',
			auth: { token: 'operator', principalId: 'instance' },
		}),
	});
	const old = context.authority.account!;
	expectOk(await context.authority.connectInstance('https://self.example'));
	expect(JSON.parse(context.writes.at(-1)!)).toEqual({
		method: 'issuer',
		origin: 'https://self.example',
		auth: null,
	});
	expect(context.authority.getState().status).toBe('signed-out');
	await expect(old.fetch('/api/example')).rejects.toThrow();
	expect(context.urls).toEqual([]);
	expect(context.events.at(-1)).toBe('relaunch');
});

test('a named issuer restores offline and repairs Alice through its own PKCE handoff without replacing the Account', async () => {
	let resumes = 0;
	const requests: Array<{ origin: string; token: string }> = [];
	using context = setup({
		authCell: JSON.stringify({
			method: 'issuer',
			origin: 'https://self.example',
			auth: { token: 'alice-1', principalId: 'alice' },
		}),
		fetch: async (input, init) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			const token = request.headers.get('authorization')?.slice(7) ?? '';
			requests.push({ origin: url.origin, token });
			if (url.pathname === '/auth/session/redeem')
				return Response.json({
					token: ((await request.json()) as { code: string }).code,
				});
			if (url.pathname === '/api/session')
				return token === 'alice-1'
					? new Response(null, { status: 401 })
					: Response.json({ principalId: 'alice' });
			return new Response('allowed');
		},
		resumeApplications: async () => {
			resumes++;
		},
	});
	const account = context.authority.account!;
	expect(context.authority.getState()).toMatchObject({
		status: 'signed-in',
		principalId: 'alice',
	});
	expect(context.authority.bootSnapshot).toMatchObject({
		baseURL: 'https://self.example',
		selectedServer: 'https://self.example',
		startSignIn: true,
		accountManagement: false,
	});
	expect(account.authorityId).not.toBe('epicenter-api');
	expect(JSON.stringify(context.authority.bootSnapshot)).not.toContain(
		'alice-1',
	);
	await expect(account.fetch('/api/example')).rejects.toThrow();
	expect(context.authority.getState().status).toBe('reauth-required');
	expect(context.authority.account).toBe(account);
	const signingIn = context.authority.startSignIn({ reauthenticate: true });
	await until(() => context.urls.length === 1);
	const url = new URL(context.urls[0]!);
	expect(url.origin).toBe('https://self.example');
	expect(url.searchParams.get('reauth')).toBe('1');
	expect(url.searchParams.get('challenge')).toBeTruthy();
	context.finish('alice-2');
	expectOk(await signingIn);
	expect(resumes).toBe(1);
	expect(context.authority.account).toBe(account);
	expect(context.events).toEqual(['stored']);
	expect(JSON.parse(context.writes.at(-1)!)).toEqual({
		method: 'issuer',
		origin: 'https://self.example',
		auth: { token: 'alice-2', principalId: 'alice' },
	});
	await account.fetch('/api/example');
	expect(requests.at(-1)).toEqual({
		origin: 'https://self.example',
		token: 'alice-2',
	});
	expect(
		requests.every((request) => request.origin === 'https://self.example'),
	).toBe(true);
});

test('first issuer sign-in persists Alice for a new host without exposing credentials to the old windows', async () => {
	using context = setup({
		authCell: JSON.stringify({
			method: 'issuer',
			origin: 'https://self.example',
			auth: null,
		}),
	});
	const signingIn = context.authority.startSignIn();
	await until(() => context.urls.length === 1);
	context.finish('alice-1');
	expectOk(await signingIn);
	expect(context.authority.account).toBeNull();
	expect(context.authority.getState().status).toBe('signed-out');
	expect(JSON.parse(context.writes.at(-1)!)).toEqual({
		method: 'issuer',
		origin: 'https://self.example',
		auth: { token: 'alice-1', principalId: 'alice' },
	});
	expect(context.events.at(-1)).toBe('relaunch');
});
