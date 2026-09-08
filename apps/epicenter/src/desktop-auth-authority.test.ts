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
	closeApplications,
	resumeApplications,
}: {
	authCell?: string | null;
	closeApplications?: () => Promise<void>;
	resumeApplications?: () => Promise<void>;
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

test('a stored session boots offline and authorizes after verification without exposing the token', async () => {
	using context = setup();
	expect(context.authority.bootSnapshot.state).toEqual({
		status: 'signed-in',
		principalId: ApiSessionResponse.assert({ principalId: 'alice' })
			.principalId,
	});
	expect(context.authority.bootSnapshot.connection).toEqual({
		baseURL: 'https://api.epicenter.so',
		authorityId: 'epicenter-api',
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
	expect((await pending).error).not.toBeNull();
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
	expect((await pending).error).not.toBeNull();
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

test('instance selection verifies and persists one cell, then retires the captured boot Account', async () => {
	using context = setup({
		fetch: async (input, init) => {
			const request = new Request(input, init);
			if (new URL(request.url).pathname === '/auth/sign-out')
				return new Response(null);
			expect(request.url).toBe('http://localhost:8788/api/session');
			expect(request.headers.get('authorization')).toBe('Bearer operator');
			return Response.json({ principalId: 'instance' });
		},
	});
	expectOk(await context.authority.prepareConnection());
	const boot = context.authority.account!;
	expectOk(
		await context.authority.connectInstance(
			'http://LOCALHOST:8788/',
			'operator',
		),
	);
	expect(context.writes.map((cell) => JSON.parse(cell!))).toEqual([
		null,
		{
			server: 'http://localhost:8788',
			auth: { token: 'operator', principalId: 'instance' },
		},
	]);
	expect(context.events).toEqual(['stored', 'stored', 'relaunch']);
	expect(context.authority.baseURL).toBe('https://api.epicenter.so');
	expect(context.authority.account).toBe(boot);
	await expect(boot.fetch('/api/example')).rejects.toBeDefined();
	expect(JSON.stringify(context.authority.bootSnapshot)).not.toContain(
		'operator',
	);
});

test('an instance boots offline with its own identity and disconnects without hosted revocation', async () => {
	using context = setup({
		authCell: JSON.stringify({
			server: 'http://localhost:8788',
			auth: { token: 'operator', principalId: 'instance' },
		}),
		fetch: async () => {
			throw new Error('Disconnect must not make requests.');
		},
	});
	expect(context.authority.account!.authorityId).toStartWith('instance-');
	expect(context.authority.bootSnapshot.connection.authorityId).toBe(
		context.authority.account!.authorityId!,
	);
	expect(context.authority.baseURL).toBe('http://localhost:8788');
	expect(context.authority.bootSnapshot.signInLocation).toBe('host-settings');
	expectOk(await context.authority.signOut());
	expect(context.writes).toEqual([
		JSON.stringify({ server: 'http://localhost:8788', auth: null }),
	]);
	expect(context.events).toEqual(['stored', 'relaunch']);
});

test('rejected instance credentials leave the original boot and stored selection intact', async () => {
	using context = setup({
		fetch: async () => new Response(null, { status: 401 }),
	});
	expectOk(await context.authority.prepareConnection());
	const boot = context.authority.account;
	expect(
		(
			await context.authority.connectInstance(
				'https://my-server.example',
				'wrong',
			)
		).error,
	).not.toBeNull();
	expect(context.writes).toEqual([]);
	expect(context.authority.account).toBe(boot);
});

test('sign-out cancels an instance verification before it can save or relaunch', async () => {
	const requested = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	using context = setup({
		authCell: null,
		fetch: async () => {
			requested.resolve();
			await release.promise;
			return Response.json({ principalId: 'instance' });
		},
	});
	expectOk(await context.authority.prepareConnection());
	const connecting = context.authority.connectInstance(
		'https://my-server.example',
		'operator',
	);
	await requested.promise;
	expectOk(await context.authority.signOut());
	expect((await connecting).error).not.toBeNull();
	release.resolve();
	await Bun.sleep(0);
	expect(context.writes).toEqual([null]);
	expect(context.events).toEqual(['stored', 'relaunch']);
});

test('cancelling an instance commit leaves the original server signed out', async () => {
	const writing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let first = true;
	using context = setup({
		fetch: async () => Response.json({ principalId: 'instance' }),
		store: async (cell) => {
			if (cell !== null && first) {
				first = false;
				writing.resolve();
				await release.promise;
			}
		},
	});
	expectOk(await context.authority.prepareConnection());
	const connecting = context.authority.connectInstance(
		'https://my-server.example',
		'operator',
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
			return Response.json({ principalId: 'instance' });
		},
	});
	expectOk(await context.authority.prepareConnection());
	const connecting = context.authority.connectInstance(
		'https://my-server.example',
		'operator',
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

for (const target of ['instance', 'hosted'] as const) {
	test(`${target} selection drains an outstanding old principal-mismatch write before saving the next boot`, async () => {
		const oldResponse = Promise.withResolvers<Response>();
		const oldRequested = Promise.withResolvers<void>();
		const clearing = Promise.withResolvers<void>();
		const releaseClear = Promise.withResolvers<void>();
		let firstClear = true;
		using context = setup({
			authCell: JSON.stringify({
				server: 'https://old.example',
				auth: { token: 'old', principalId: 'instance' },
			}),
			fetch: async (input) => {
				if (new URL(String(input)).origin === 'https://old.example') {
					oldRequested.resolve();
					return oldResponse.promise;
				}
				return Response.json({ principalId: 'instance' });
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
		expectOk(await context.authority.prepareConnection());
		const selecting =
			target === 'instance'
				? context.authority.connectInstance('https://new.example', 'operator')
				: context.authority.selectHosted();
		await Bun.sleep(0);
		expect(context.writes).toEqual([]);
		expect(context.events).not.toContain('relaunch');
		releaseClear.resolve();
		expectOk(await selecting);
		await oldRequest;
		expect(context.writes.map((cell) => JSON.parse(cell ?? 'null'))).toEqual([
			{ server: 'https://old.example', auth: null },
			{ server: 'https://old.example', auth: null },
			target === 'instance'
				? {
						server: 'https://new.example',
						auth: { token: 'operator', principalId: 'instance' },
					}
				: null,
		]);
		expect(context.events.at(-1)).toBe('relaunch');
	});
}

test('server selection is refused until every application has closed', async () => {
	const closed = Promise.withResolvers<void>();
	using context = setup({ closeApplications: () => closed.promise });
	expect(
		(await context.authority.connectInstance('https://example.com', 'token'))
			.error,
	).not.toBeNull();
	expect((await context.authority.selectHosted()).error).not.toBeNull();
	const preparing = context.authority.prepareConnection();
	expect((await context.authority.selectHosted()).error).not.toBeNull();
	expect(context.writes).toEqual([]);
	closed.resolve();
	expectOk(await preparing);
	expectOk(await context.authority.cancelConnection());
	expect((await context.authority.selectHosted()).error).not.toBeNull();
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
	expect(context.authority.state.status).toBe('signed-in');
	expect((await context.authority.prepareConnection()).error).not.toBeNull();
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

test('cancelling preparation revokes selection before the native launch gate reopens', async () => {
	const resumed = Promise.withResolvers<void>();
	let closes = 0;
	using context = setup({
		closeApplications: async () => {
			closes++;
		},
		resumeApplications: () => resumed.promise,
	});
	expectOk(await context.authority.prepareConnection());
	const cancelling = context.authority.cancelConnection();
	expect(
		(await context.authority.connectInstance('https://example.com', 'token'))
			.error,
	).not.toBeNull();
	expect((await context.authority.selectHosted()).error).not.toBeNull();
	expect((await context.authority.prepareConnection()).error).not.toBeNull();
	expect((await context.authority.startSignIn()).error).not.toBeNull();
	expect(context.writes).toEqual([]);
	expect(closes).toBe(1);
	resumed.resolve();
	expectOk(await cancelling);
	expect((await context.authority.selectHosted()).error).not.toBeNull();
	expectOk(await context.authority.prepareConnection());
	expect(closes).toBe(2);
});

for (const failure of ['candidate-save', 'old-sign-out'] as const) {
	test(`cancel after ${failure} failure restarts the original server signed out`, async () => {
		const originalServer = 'https://old.example';
		let fail = true;
		let resumed = false;
		using context = setup({
			authCell: JSON.stringify({
				server: originalServer,
				auth: { token: 'old', principalId: 'instance' },
			}),
			fetch: async () => Response.json({ principalId: 'instance' }),
			resumeApplications: async () => {
				resumed = true;
			},
			store: async (cell) => {
				const value = JSON.parse(cell ?? 'null');
				if (
					fail &&
					(failure === 'candidate-save'
						? value?.auth?.token === 'new'
						: value?.auth === null)
				) {
					fail = false;
					throw new Error('native write failed');
				}
			},
		});
		expectOk(await context.authority.prepareConnection());
		expect(
			(await context.authority.connectInstance('https://new.example', 'new'))
				.error,
		).not.toBeNull();
		expect(context.authority.state.status).toBe('signed-out');
		expect(context.events).not.toContain('relaunch');
		expectOk(await context.authority.cancelConnection());
		expect(context.writes.at(-1)).toBe(
			JSON.stringify({ server: originalServer, auth: null }),
		);
		expect(resumed).toBe(false);
		expect(context.events.at(-1)).toBe('relaunch');
	});
}

test('failed cancellation clear never relaunches or reopens a retired boot', async () => {
	let resumed = false;
	using context = setup({
		fetch: async () => Response.json({ principalId: 'instance' }),
		store: async () => {
			throw new Error('native storage unavailable');
		},
		resumeApplications: async () => {
			resumed = true;
		},
	});
	expectOk(await context.authority.prepareConnection());
	expect(
		(await context.authority.connectInstance('https://new.example', 'new'))
			.error,
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
	expect(context.authority.state.status).toBe('signed-out');
	expect(context.events).toEqual([]);
	expect(resumed).toBe(false);
	release.resolve();
	expect((await signingIn).error).not.toBeNull();
	expect(context.writes).toEqual([null]);
	expect(context.events).toEqual(['stored', 'relaunch']);
	expect(resumed).toBe(false);
});
