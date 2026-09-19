/**
 * Native session ownership and process-generation isolation.
 *
 * Real core auth and handoff parsing run behind a controlled native port.
 * Cancellation settles before an opener acknowledgement; a failed relaunch
 * never gives an old window the replacement Account or its credential.
 */
import { expect, spyOn, test } from 'bun:test';
import {
	ApiSessionResponse,
	type AuthFetch,
	type AuthServer,
	epicenterCloud,
	selfHostedServer,
} from '@epicenter/auth';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createDesktopAuthAuthority } from './desktop-auth-authority.ts';

const STORED_CELL = JSON.stringify({
	origin: 'https://api.epicenter.so',
	auth: { token: 'alice-1', principalId: 'alice' },
});

function setup({
	authCell = STORED_CELL,
	server = epicenterCloud('https://api.epicenter.so'),
	accountManagement = true,
	open,
	relaunch,
	fetch: fetchOverride,
	respond,
	store,
	callbackUrl,
}: {
	authCell?: string | null;
	server?: AuthServer;
	accountManagement?: boolean;
	callbackUrl?: string;
	open?: (url: string) => Promise<void>;
	relaunch?: () => void;
	fetch?: AuthFetch;
	respond?: (request: Request) => Promise<Response | undefined>;
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
		server,
		accountManagement,
		callbackUrl,
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
				const intercepted = await respond?.(request.clone());
				if (intercepted) return intercepted;
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

test('a stored session boots offline and authorizes after verification without exposing the token', async () => {
	using context = setup();
	expect(context.authority.bootSnapshot.state).toEqual({
		status: 'signed-in',
		principalId: ApiSessionResponse.assert({ principalId: 'alice' })
			.principalId,
	});
	expect(context.authority.bootSnapshot).toMatchObject({
		server: epicenterCloud('https://api.epicenter.so'),
		credentialUnreadable: false,
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

test('unsafe native cells expose no identity and leave saved bytes untouched until deliberate authentication', async () => {
	for (const authCell of [
		'not-json',
		JSON.stringify({ token: 'alice-1', principalId: 'alice' }),
		JSON.stringify({
			method: 'cloud',
			origin: 'https://other.example',
			auth: { token: 'alice-1', principalId: 'alice' },
		}),
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
		expect(context.authority.bootSnapshot.credentialUnreadable).toBe(true);
		const signingIn = context.authority.startSignIn();
		await until(() => context.urls.length === 1);
		expectOk(await context.authority.cancelConnection());
		expectErr(await signingIn);
		expect(context.writes).toEqual([]);
		expect(requests).toBe(0);
	}
});

test('sign-in replaces an unreadable credential without restoring or revoking its token', async () => {
	using context = setup({
		authCell: JSON.stringify({ token: 'unsafe', principalId: 'alice' }),
	});
	expect(context.authority.bootSnapshot.credentialUnreadable).toBe(true);
	const signingIn = context.authority.startSignIn();
	await until(() => context.urls.length === 1);
	context.finish('alice-2');
	expectOk(await signingIn);
	expect(context.writes).toEqual([
		JSON.stringify({
			origin: 'https://api.epicenter.so',
			auth: { token: 'alice-2', principalId: 'alice' },
		}),
	]);
	expect(context.events).toEqual(['stored', 'relaunch']);
	expect(context.authority.account).toBeNull();
	expect(context.revoked).toEqual([]);
});

test('a rebuild for another issuer neither restores nor revokes the previous origin credential', async () => {
	using context = setup({
		server: selfHostedServer('https://new.example'),
		authCell: JSON.stringify({
			method: 'issuer',
			origin: 'https://old.example',
			auth: { token: 'old-secret', principalId: 'alice' },
		}),
	});
	expect(context.authority.account).toBeNull();
	expect(context.authority.bootSnapshot.credentialUnreadable).toBe(true);
	const signingIn = context.authority.startSignIn();
	await until(() => context.urls.length === 1);
	expect(new URL(context.urls[0]!).origin).toBe('https://new.example');
	context.finish('alice-new');
	expectOk(await signingIn);
	expect(context.revoked).toEqual([]);
	expect(context.resources).toEqual([]);
	expect(context.writes.map((cell) => JSON.parse(cell!))).toEqual([
		{
			origin: 'https://new.example',
			auth: { token: 'alice-new', principalId: 'alice' },
		},
	]);
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

test('duplicate same-owner sign-in calls persist once and retire the boot Account for restart', async () => {
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
	expect(JSON.parse(context.writes[0]!).auth).toEqual({
		token: 'alice-2',
		principalId: 'alice',
	});
	expect(context.authority.account).toBe(account);
	await expect(account!.fetch('/api/example')).rejects.toBeDefined();
	expect(context.resources).toEqual([]);
	expect(context.authority.restartRequired).toBe(true);
	expect(context.authority.getState()).toEqual({ status: 'signed-out' });
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
	expectErr(await pending);
	expect(context.authority.restartRequired).toBe(true);
	expectErr(await context.authority.cancelConnection());
	expectErr(await context.authority.startSignIn());
	expectErr(await context.authority.signOut());
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
	expectErr(await pending);
	expect(context.authority.restartRequired).toBe(true);
	expectErr(await context.authority.cancelConnection());
	expectErr(await context.authority.startSignIn());
	expectErr(await context.authority.signOut());
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
			expectErr(await pending);
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
		expectErr(await context.authority.startSignIn());
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
	expectErr(await context.authority.startSignIn());
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

test('a named issuer restores offline and prepares reauthentication for the next process', async () => {
	const requests: Array<{ origin: string; token: string }> = [];
	using context = setup({
		server: selfHostedServer('https://self.example'),
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
	});
	const account = context.authority.account!;
	expect(context.authority.getState()).toMatchObject({
		status: 'signed-in',
		principalId: 'alice',
	});
	expect(context.authority.bootSnapshot).toMatchObject({
		server: selfHostedServer('https://self.example'),
		credentialUnreadable: false,
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
	expect(context.authority.account).toBe(account);
	expect(context.events).toEqual(['stored', 'relaunch']);
	expect(JSON.parse(context.writes.at(-1)!)).toEqual({
		origin: 'https://self.example',
		auth: { token: 'alice-2', principalId: 'alice' },
	});
	await expect(account.fetch('/api/example')).rejects.toBeDefined();
	expect(context.authority.restartRequired).toBe(true);
	expect(
		requests.every((request) => request.origin === 'https://self.example'),
	).toBe(true);
});

test('first issuer sign-in persists Alice for a new host without exposing credentials to the old windows', async () => {
	using context = setup({
		server: selfHostedServer('https://self.example'),
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
		origin: 'https://self.example',
		auth: { token: 'alice-1', principalId: 'alice' },
	});
	expect(context.events.at(-1)).toBe('relaunch');
});

test('old signed-out envelopes need no credential recovery or network access', () => {
	for (const authCell of [
		'null',
		JSON.stringify({
			method: 'issuer',
			origin: 'https://old.example',
			auth: null,
		}),
		JSON.stringify({ method: 'instance', origin: 'invalid', auth: null }),
	]) {
		using context = setup({
			authCell,
			fetch: async () => {
				throw new Error('Signed-out startup cannot request credentials.');
			},
		});
		expect(context.authority.bootSnapshot.state).toEqual({
			status: 'signed-out',
		});
		expect(context.authority.bootSnapshot.credentialUnreadable).toBe(false);
		expect(context.writes).toEqual([]);
	}
});

test('feature settings do not select or retire a named session', () => {
	for (const method of [undefined, 'cloud', 'issuer']) {
		for (const accountManagement of [false, true]) {
			using context = setup({
				server: {
					baseURL: 'https://server.example',
					authorityId: 'stable-server',
				},
				accountManagement,
				authCell: JSON.stringify({
					method,
					origin: 'https://server.example',
					auth: { token: 'alice-1', principalId: 'alice' },
				}),
				fetch: async () => {
					throw new Error('Offline restoration must not request credentials.');
				},
			});
			expect(String(context.authority.account?.principalId)).toBe('alice');
			expect(context.authority.account?.authorityId).toBe('stable-server');
			expect(context.authority.bootSnapshot.accountManagement).toBe(
				accountManagement,
			);
			expect(context.authority.bootSnapshot.credentialUnreadable).toBe(false);
			expect(context.writes).toEqual([]);
		}
	}
});

test('cancelling before acceptance keeps boot access and saved credentials intact', async () => {
	using context = setup();
	const account = context.authority.account!;
	const pending = context.authority.startSignIn();
	await until(() => context.urls.length === 1);
	expectOk(await context.authority.cancelConnection());
	expectErr(await pending);
	context.finish();
	await account.fetch('/api/example');
	expect(context.resources).toEqual(['alice-1']);
	expect(context.writes).toEqual([]);
	expect(context.events).toEqual([]);
	expect(context.authority.account).toBe(account);
	expect(context.authority.restartRequired).toBe(false);
});

test('accepted sign-in fences immediately and rejects cancellation and competing sign-out', async () => {
	const saving = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	using context = setup({
		async store() {
			saving.resolve();
			await release.promise;
		},
	});
	const boot = context.authority.account!;
	const signingIn = context.authority.startSignIn();
	await until(() => context.urls.length === 1);
	context.finish('alice-2');
	await saving.promise;
	expect(context.authority.restartRequired).toBe(true);
	expect(context.authority.account).toBe(boot);
	expect(context.authority.getState()).toEqual({ status: 'signed-out' });
	await expect(boot.fetch('/api/example')).rejects.toBeDefined();
	expectErr(await context.authority.cancelConnection());
	expectErr(await context.authority.signOut());
	expectErr(await context.authority.startSignIn());
	expect(context.writes).toEqual([]);
	expect(context.events).toEqual([]);
	release.resolve();
	expectOk(await signingIn);
	expect(context.writes.map((cell) => JSON.parse(cell!).auth)).toEqual([
		{ token: 'alice-2', principalId: 'alice' },
	]);
	expect(context.events).toEqual(['stored', 'relaunch']);
	expect(context.resources).toEqual([]);
	expect(context.revoked).toEqual(['alice-1']);
});

for (const phase of ['redemption', 'verification'] as const) {
	for (const action of ['cancel', 'sign-out'] as const) {
		test(`${action} during ${phase} prevents a late result from overwriting the winning credentials`, async () => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			using context = setup({
				async respond(request) {
					const path = new URL(request.url).pathname;
					const token = request.headers.get('authorization')?.slice(7);
					const held =
						phase === 'redemption'
							? path === '/auth/session/redeem' &&
								((await request.json()) as { code: string }).code === 'orphan'
							: path === '/api/session' && token === 'orphan';
					if (held) {
						entered.resolve();
						// Ignore abort deliberately: a remote result may arrive late.
						await release.promise;
					}
					return undefined;
				},
			});
			const old = context.authority.startSignIn();
			await until(() => context.urls.length === 1);
			context.finish('orphan');
			await entered.promise;
			if (action === 'cancel') {
				expectOk(await context.authority.cancelConnection());
				expect(context.authority.restartRequired).toBe(false);
				const next = context.authority.startSignIn();
				await until(() => context.urls.length === 2);
				context.finish('bob-2');
				expectOk(await next);
			} else {
				expectOk(await context.authority.signOut());
				expectErr(await context.authority.startSignIn());
			}
			expectErr(await old);
			release.resolve();
			await until(() => context.revoked.includes('orphan'));
			expect(
				context.writes.map((cell) =>
					cell === null ? null : JSON.parse(cell).auth,
				),
			).toEqual(
				action === 'cancel' ? [{ token: 'bob-2', principalId: 'bob' }] : [null],
			);
			expect(context.events).toEqual(['stored', 'relaunch']);
			expect(context.revoked).not.toContain('bob-2');
			expect(context.authority.restartRequired).toBe(true);
		});
	}
}

for (const rejectOldWrite of [false, true]) {
	test(`queued boot mismatch write ${rejectOldWrite ? 'failure' : 'completion'} precedes successor persistence`, async () => {
		const clearing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const attempted: Array<string | null> = [];
		using context = setup({
			async respond(request) {
				if (
					new URL(request.url).pathname === '/api/session' &&
					request.headers.get('authorization') === 'Bearer alice-1'
				) {
					return Response.json({ principalId: 'other' });
				}
				return undefined;
			},
			async store(cell) {
				attempted.push(cell);
				if (cell === null) {
					clearing.resolve();
					await release.promise;
					if (rejectOldWrite) throw new Error('old clear failed');
				}
			},
		});
		const oldAccess = context.authority.account!.fetch('/api/example');
		void oldAccess.catch(() => {});
		await clearing.promise;
		const next = context.authority.startSignIn();
		await until(() => context.urls.length === 1);
		context.finish('bob-2');
		await until(() => !context.listening);
		expect(attempted).toEqual([null]);
		expect(context.events).toEqual([]);
		release.resolve();
		await expect(oldAccess).rejects.toBeDefined();
		expectOk(await next);
		expect(
			attempted.map((cell) => (cell === null ? null : JSON.parse(cell).auth)),
		).toEqual([null, { token: 'bob-2', principalId: 'bob' }]);
		expect(JSON.parse(context.writes.at(-1)!).auth.token).toBe('bob-2');
		expect(context.events.at(-1)).toBe('relaunch');
	});
}

test('late boot verification cannot clear successor credentials after acceptance', async () => {
	const verifying = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const returned = Promise.withResolvers<void>();
	using context = setup({
		async respond(request) {
			if (
				new URL(request.url).pathname === '/api/session' &&
				request.headers.get('authorization') === 'Bearer alice-1'
			) {
				verifying.resolve();
				await release.promise;
				returned.resolve();
				return Response.json({ principalId: 'other' });
			}
			return undefined;
		},
	});
	const oldAccess = context.authority.account!.fetch('/api/example');
	void oldAccess.catch(() => {});
	await verifying.promise;
	const next = context.authority.startSignIn();
	await until(() => context.urls.length === 1);
	context.finish('bob-2');
	expectOk(await next);
	await expect(oldAccess).rejects.toBeDefined();
	release.resolve();
	await returned.promise;
	await Bun.sleep(0);
	expect(context.writes.map((cell) => JSON.parse(cell!).auth)).toEqual([
		{ token: 'bob-2', principalId: 'bob' },
	]);
	expect(context.resources).toEqual([]);
});

for (const action of ['sign-in', 'sign-out'] as const) {
	test(`${action} storage mutation followed by rejection leaves access fenced and never relaunches`, async () => {
		let actualCell: string | null = STORED_CELL;
		using context = setup({
			async store(value) {
				actualCell = value;
				throw new Error('acknowledgement failed after storage changed');
			},
		});
		const boot = context.authority.account!;
		if (action === 'sign-in') {
			const pending = context.authority.startSignIn();
			await until(() => context.urls.length === 1);
			context.finish('bob-2');
			expectErr(await pending);
			expect(JSON.parse(actualCell!).auth.token).toBe('bob-2');
			expect(context.revoked).toContain('bob-2');
		} else {
			expectErr(await context.authority.signOut());
			expect(actualCell).toBeNull();
			expect(context.revoked).toContain('alice-1');
		}
		expect(context.authority.restartRequired).toBe(true);
		expect(context.authority.account).toBe(boot);
		await expect(boot.fetch('/api/example')).rejects.toBeDefined();
		expect(context.events).not.toContain('relaunch');
		expect(context.resources).toEqual([]);
		expectErr(await context.authority.cancelConnection());
		expectErr(await context.authority.startSignIn());
		expectErr(await context.authority.signOut());
	});
}

test('a hung revocation is bounded even when fetch ignores its abort signal', async () => {
	const timeout = AbortSignal.timeout.bind(AbortSignal);
	const requested: number[] = [];
	const timer = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
		requested.push(ms);
		return timeout(ms === 5_000 ? 5 : ms);
	});
	try {
		using context = setup({
			async fetch() {
				return new Promise<Response>(() => {});
			},
		});
		expectOk(await context.authority.signOut());
		expect(requested).toContain(5_000);
		expect(context.writes).toEqual([null]);
		expect(context.events).toEqual(['stored', 'relaunch']);
		expect(context.authority.restartRequired).toBe(true);
	} finally {
		timer.mockRestore();
	}
});

for (const failure of ['rejected', 'unreachable', 'malformed'] as const) {
	test(`${failure} successor verification leaves boot access usable and revokes the orphan`, async () => {
		using context = setup({
			async respond(request) {
				if (
					new URL(request.url).pathname !== '/api/session' ||
					request.headers.get('authorization') !== 'Bearer bob-2'
				)
					return undefined;
				if (failure === 'rejected') return new Response(null, { status: 401 });
				if (failure === 'unreachable') throw new Error('network offline');
				return Response.json({ invalid: true });
			},
		});
		const pending = context.authority.startSignIn();
		await until(() => context.urls.length === 1);
		context.finish('bob-2');
		expectErr(await pending);
		expect(context.authority.restartRequired).toBe(false);
		await context.authority.account!.fetch('/api/example');
		expect(context.resources).toEqual(['alice-1']);
		expect(context.writes).toEqual([]);
		expect(context.events).toEqual([]);
		expect(context.revoked).toEqual(['bob-2']);
	});
}

test('boot principal mismatch requires restart before the asynchronous clear finishes', async () => {
	const clearing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	using context = setup({
		async respond(request) {
			if (new URL(request.url).pathname === '/api/session')
				return Response.json({ principalId: 'other' });
			return undefined;
		},
		async store() {
			clearing.resolve();
			await release.promise;
		},
	});
	const boot = context.authority.account!;
	const access = boot.fetch('/api/example');
	void access.catch(() => {});
	await clearing.promise;
	expect(context.authority.restartRequired).toBe(true);
	expect(context.authority.account).toBe(boot);
	expect(context.authority.getState()).toEqual({ status: 'signed-out' });
	expect(context.authority.bootSnapshot.state).toMatchObject({
		principalId: 'alice',
	});
	expect(context.writes).toEqual([]);
	expect(context.events).not.toContain('relaunch');
	await expect(access).rejects.toBeDefined();
	await expect(boot.fetch('/api/example')).rejects.toBeDefined();
	release.resolve();
	await until(() => context.writes.length === 1);
	expect(context.writes).toEqual([null]);
	expect(context.authority.restartRequired).toBe(true);
});
