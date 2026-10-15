/**
 * Dashboard attachments isolate late billing, profile, provider, and mutation
 * results even when a later attachment has the same principal. Management and
 * billing requests go through the captured Account with this origin's cookie
 * and name the captured principal, so the server can refuse a changed cookie.
 */
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { asPrincipalId } from '@epicenter/principal';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { accountKeys } from '../account/queries.js';
import { createCookieSessionAuth } from '../auth/cookie-session.js';
import { billingKeys } from '../billing/queries.js';
import { createDashboardRuntime } from './runtime.js';

function setup(principalId: string) {
	const started = Promise.withResolvers<void>();
	const pending: {
		request: Request;
		credentials: RequestCredentials | undefined;
		complete(body: unknown): void;
	}[] = [];
	const account: Account = {
		authorityId: 'test-authority',
		principalId: asPrincipalId(principalId),
		baseURL: 'https://api.example.test',
		fetch(input, init) {
			const request = new Request(
				input instanceof Request ? input : new URL(input, account.baseURL),
				init,
			);
			return new Promise<Response>((resolve) => {
				pending.push({
					request,
					credentials: init?.credentials,
					complete: (body) => resolve(Response.json(body)),
				});
				if (pending.length === 5) started.resolve();
			});
		},
		getProfile: async () => Ok({ id: asPrincipalId(principalId) }),
	};
	return {
		dashboard: createDashboardRuntime(account),
		pending,
		started: started.promise,
	};
}

for (const successor of ['bob', 'alice']) {
	test(`late results from Alice cannot populate a new ${successor} attachment`, async () => {
		const {
			dashboard: old,
			pending: oldRequests,
			started: oldStarted,
		} = setup('alice');
		const {
			dashboard: current,
			pending: currentRequests,
			started: currentStarted,
		} = setup(successor);
		try {
			const oldWork = Promise.all([
				old.billing.overview.fetch(),
				old.accountQueries.session.fetch(),
				old.accountQueries.linked.fetch(),
				old.accountQueries.passkeys.fetch(),
				old.billing.checkoutPlan({ planId: 'old-plan' }),
			]);
			await oldStarted;
			expect(oldRequests).toHaveLength(5);
			old[Symbol.dispose]();
			expect(old.signal.aborted).toBe(true);
			const currentWork = Promise.all([
				current.billing.overview.fetch(),
				current.accountQueries.session.fetch(),
				current.accountQueries.linked.fetch(),
				current.accountQueries.passkeys.fetch(),
				current.billing.checkoutPlan({ planId: 'current-plan' }),
			]);
			await currentStarted;
			expect(currentRequests).toHaveLength(5);
			for (const { request, complete } of currentRequests) {
				const path = new URL(request.url).pathname;
				complete(
					path.includes('list-') ? [{ id: 'current' }] : { marker: 'current' },
				);
			}
			for (const result of await currentWork) expectOk<unknown>(result);
			const cacheBefore = current.queryClient
				.getQueryCache()
				.getAll()
				.map((query) => query.state.data);
			for (const { complete } of oldRequests) complete({ marker: 'old' });
			await oldWork;
			expect(
				current.queryClient
					.getQueryCache()
					.getAll()
					.map((query) => query.state.data),
			).toEqual(cacheBefore);
			expect(
				current.queryClient.getQueryData<unknown>(billingKeys.overview),
			).toEqual({ marker: 'current' });
			expect(
				current.queryClient.getQueryData<unknown>(accountKeys.session),
			).toEqual({ marker: 'current' });
			expect(
				current.queryClient.getQueryData<unknown>(accountKeys.linked),
			).toEqual([{ id: 'current' }]);
			expect(
				current.queryClient.getQueryData<unknown>(accountKeys.passkeys),
			).toEqual([{ id: 'current' }]);
			expect(
				current.queryClient
					.getMutationCache()
					.getAll()
					.map((mutation) => mutation.state.data),
			).toEqual([{ marker: 'current' }]);
			expect(old.queryClient.getQueryCache().getAll()).toHaveLength(0);
			expect(old.queryClient.getMutationCache().getAll()).toHaveLength(0);
		} finally {
			old[Symbol.dispose]();
			current[Symbol.dispose]();
		}
	});
}

test('management and billing requests name the captured principal and send the cookie', async () => {
	const { dashboard, pending, started } = setup('alice');
	try {
		const work = Promise.all([
			dashboard.management.getSession(),
			dashboard.management.listAccounts(),
			dashboard.management.unlinkAccount(
				{ accountId: 'alice-github' },
				{
					headers: { 'x-epicenter-principal': 'bob' },
					credentials: 'omit',
				},
			),
			dashboard.management.passkey.deletePasskey({ id: 'alice-passkey' }),
			dashboard.billingApi.checkoutTopUp(),
		]);
		await started;
		expect(pending).toHaveLength(5);
		for (const { request, credentials, complete } of pending) {
			expect(request.headers.get('x-epicenter-principal')).toBe('alice');
			// Bun 1.3's Request.credentials getter always returns include.
			expect(credentials).toBe('include');
			complete({ status: true });
		}
		for (const result of await work) expect(result.error).toBeNull();
	} finally {
		dashboard[Symbol.dispose]();
	}
});

for (const successor of ['bob', 'alice']) {
	test(`sign-out then ${successor} sign-in retires old dashboard operations`, async () => {
		const oldStarted = Promise.withResolvers<void>();
		const lateResponse = Promise.withResolvers<Response>();
		const sent: {
			path: string;
			authorization: string | null;
			principal: string | null;
			credentials: RequestCredentials | undefined;
		}[] = [];
		let cookie: string | null = 'alice';
		let overviews = 0;
		const auth = createCookieSessionAuth({
			origin: 'https://api.example.test',
			navigate() {},
			returnPath: () => '/dashboard',
			async fetch(input, init) {
				const path = new URL(input instanceof Request ? input.url : input)
					.pathname;
				const headers = new Headers(
					init?.headers ?? (input instanceof Request ? input.headers : {}),
				);
				sent.push({
					path,
					authorization: headers.get('authorization'),
					principal: headers.get('x-epicenter-principal'),
					credentials: init?.credentials,
				});
				if (path === '/auth/get-session')
					return Response.json(
						cookie
							? { session: {}, user: { id: cookie, email: `${cookie}@x.test` } }
							: null,
					);
				if (path === '/auth/sign-out') {
					cookie = null;
					return Response.json({ success: true });
				}
				if (path === '/api/billing/overview' && ++overviews === 1) {
					oldStarted.resolve();
					return lateResponse.promise;
				}
				return Response.json({ marker: 'new attachment' });
			},
		});
		const dashboards: ReturnType<typeof createDashboardRuntime>[] = [];
		try {
			await auth.refresh();
			const oldState = auth.getState();
			if (oldState.status === 'signed-out') throw new Error('Expected Alice');
			const old = createDashboardRuntime(oldState.account);
			dashboards.push(old);
			const pending = old.billing.overview.fetch();
			await oldStarted.promise;
			expectOk(await auth.signOut());
			expect(auth.getState().status).toBe('signed-out');
			old[Symbol.dispose]();
			cookie = successor;
			await auth.refresh();
			const newState = auth.getState();
			if (newState.status === 'signed-out')
				throw new Error('Expected successor');
			expect(newState.account).not.toBe(oldState.account);
			const current = createDashboardRuntime(newState.account);
			dashboards.push(current);
			expectOk(await current.billing.overview.fetch());
			expect((await current.management.getSession()).error).toBeNull();
			expect(sent.at(-1)).toEqual({
				path: '/auth/get-session',
				authorization: null,
				principal: successor,
				credentials: 'include',
			});
			lateResponse.resolve(Response.json({ marker: 'old attachment' }));
			await pending;
			const requestsBefore = sent.length;
			const retired = await Promise.all([
				old.accountQueries.session.fetch(),
				old.accountQueries.linked.fetch(),
				old.accountQueries.passkeys.fetch(),
				old.billing.checkoutPlan({ planId: 'retired' }),
			]);
			for (const result of retired) expect(result.error).not.toBeNull();
			expect(sent).toHaveLength(requestsBefore);
			expect(
				current.queryClient.getQueryData<unknown>(billingKeys.overview),
			).toEqual({ marker: 'new attachment' });
			expect(current.queryClient.getMutationCache().getAll()).toHaveLength(0);
		} finally {
			lateResponse.resolve(Response.json({}));
			for (const dashboard of dashboards) dashboard[Symbol.dispose]();
			auth[Symbol.dispose]();
		}
	});
}
