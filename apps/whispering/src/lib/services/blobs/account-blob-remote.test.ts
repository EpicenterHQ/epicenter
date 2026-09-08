/**
 * A blob transfer belongs to the account captured by its session.
 * Exercises the real session account transport and blob remote composition,
 * including delayed local reads, a 401 across account replacement, and a
 * later sign-in to the same principal.
 */
import { expect, test } from 'bun:test';
import { type AuthFetch, createSessionAuth } from '@epicenter/auth';
import {
	type BlobStore,
	BlobStoreError,
	generateBlobId,
} from '@epicenter/blobs';
import {
	createBrowserBlobRemote,
	createEpicenterClient,
} from '@epicenter/client';
import { asPrincipalId } from '@epicenter/principal';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';

function setup(
	resourceFetch: AuthFetch = async () => new Response(null, { status: 204 }),
) {
	const sent: (string | null)[] = [];
	const auth = createSessionAuth({
		baseURL: 'https://example.test',
		persistedAuthStorage: {
			initial: { principalId: asPrincipalId('alice'), token: 'alice' },
			set() {},
		},
		launcher: {
			startSignIn: async () => ({ status: 'completed', token: 'bob' }),
		},
		fetch: async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			const bearer = new Headers(init?.headers).get('Authorization');
			if (url.endsWith('/api/session'))
				return Response.json({
					principalId: bearer === 'Bearer bob' ? 'bob' : 'alice',
					email: 'test@example.test',
				});
			if (url.includes('/auth/')) return new Response(null, { status: 204 });
			sent.push(bearer);
			return resourceFetch(input, init);
		},
	});
	return {
		auth,
		sent,
		get account() {
			const state = auth.state;
			if (state.status === 'signed-out')
				throw new Error('Expected a signed-in test account.');
			return state.account;
		},
	};
}

test('a delayed local read cannot request an upload ticket for the next account', async () => {
	const context = setup();
	const started = Promise.withResolvers<void>();
	const bytes = Promise.withResolvers<Blob>();
	const local: BlobStore = {
		get: async () => {
			started.resolve();
			return Ok(await bytes.promise);
		},
		put: async () => Ok(undefined),
		delete: async () => Ok(undefined),
		stat: async (id) => BlobStoreError.BlobNotFound({ id }),
		statMany: async (ids) =>
			ids.map((id) => BlobStoreError.BlobNotFound({ id })),
	};
	const account = context.account;
	const remote = createBrowserBlobRemote({
		local,
		client: createEpicenterClient({
			baseURL: account.baseURL,
			fetch: account.fetch,
		}),
	});
	try {
		const upload = remote.upload(generateBlobId());
		await started.promise;
		expectOk(await context.auth.startSignIn());
		bytes.resolve(new Blob(['alice audio']));
		expect(expectErr(await upload).name).toBe('BlobRemoteFailed');
		expect(context.sent).toEqual([]);
	} finally {
		bytes.resolve(new Blob());
		context.auth[Symbol.dispose]();
	}
});

test('a 401 across account replacement cannot retry with the new bearer', async () => {
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const context = setup(async () => {
		entered.resolve();
		await finish.promise;
		return new Response(null, { status: 401 });
	});
	try {
		const account = context.account;
		const pending = account.fetch('/api/blobs/example').then(
			() => undefined,
			(error: unknown) => error,
		);
		await entered.promise;
		expectOk(await context.auth.startSignIn());
		finish.resolve();
		expect(await pending).toBeInstanceOf(Error);
		expect(context.sent).toEqual(['Bearer alice']);
		await expect(account.fetch('/api/blobs/example')).rejects.toBeInstanceOf(
			Error,
		);
	} finally {
		finish.resolve();
		context.auth[Symbol.dispose]();
	}
});

test('signing back into the same principal does not revive its earlier account transport', async () => {
	const context = setup();
	try {
		expectOk(await context.auth.startSignIn());
		const first = context.account;
		expectOk(await context.auth.signOut());
		expectOk(await context.auth.startSignIn());
		expect(context.account.principalId).toBe(first.principalId);
		expect(context.account).not.toBe(first);
		await expect(first.fetch('/api/blobs/example')).rejects.toBeInstanceOf(
			Error,
		);
		expect((await context.account.fetch('/api/blobs/example')).status).toBe(
			204,
		);
		expect(context.sent).toEqual(['Bearer bob']);
	} finally {
		context.auth[Symbol.dispose]();
	}
});
