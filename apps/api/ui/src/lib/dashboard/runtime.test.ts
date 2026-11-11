/**
 * Dashboard attachments isolate late billing, profile, provider, and mutation
 * results even when a later attachment has the same principal. Management and
 * billing requests go through the captured Account with this origin's cookie
 * and name the captured principal, so the server can refuse a changed cookie.
 */
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/account';
import { asPrincipalId } from '@epicenter/account';
import { runMutation, runQuery } from 'wellcrafted/query';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { createCookieSessionAuth } from '../auth/cookie-session.js';
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
		signal: new AbortController().signal,
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
				runQuery(old.queryClient, old.billingQueries.overview()),
				runQuery(old.queryClient, old.accountQueries.session()),
				runQuery(old.queryClient, old.accountQueries.linked()),
				runQuery(old.queryClient, old.accountQueries.passkeys()),
				runMutation(old.queryClient, old.billingMutations.checkoutPlan, {
					planId: 'old-plan',
				}),
			]);
			await oldStarted;
			expect(oldRequests).toHaveLength(5);
			old[Symbol.dispose]();
			expect(old.signal.aborted).toBe(true);
			const currentWork = Promise.all([
				runQuery(current.queryClient, current.billingQueries.overview()),
				runQuery(current.queryClient, current.accountQueries.session()),
				runQuery(current.queryClient, current.accountQueries.linked()),
				runQuery(current.queryClient, current.accountQueries.passkeys()),
				runMutation(
					current.queryClient,
					current.billingMutations.checkoutPlan,
					{ planId: 'current-plan' },
				),
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
			expect<unknown>(
				current.queryClient.getQueryData(
					current.billingQueries.overview().queryKey,
				),
			).toEqual({ marker: 'current' });
			expect<unknown>(
				current.queryClient.getQueryData(
					current.accountQueries.session().queryKey,
				),
			).toEqual({ marker: 'current' });
			expect<unknown>(
				current.queryClient.getQueryData(
					current.accountQueries.linked().queryKey,
				),
			).toEqual([{ id: 'current' }]);
			expect<unknown>(
				current.queryClient.getQueryData(
					current.accountQueries.passkeys().queryKey,
				),
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
			const oldState = auth.state();
			if (oldState.status === 'signed-out') throw new Error('Expected Alice');
			const old = createDashboardRuntime(oldState.account);
			dashboards.push(old);
			const pending = runQuery(old.queryClient, old.billingQueries.overview());
			await oldStarted.promise;
			expectOk(await auth.signOut());
			expect(auth.state().status).toBe('signed-out');
			old[Symbol.dispose]();
			cookie = successor;
			await auth.refresh();
			const newState = auth.state();
			if (newState.status === 'signed-out')
				throw new Error('Expected successor');
			expect(newState.account).not.toBe(oldState.account);
			const current = createDashboardRuntime(newState.account);
			dashboards.push(current);
			expectOk(
				await runQuery(current.queryClient, current.billingQueries.overview()),
			);
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
				runQuery(old.queryClient, old.accountQueries.session()),
				runQuery(old.queryClient, old.accountQueries.linked()),
				runQuery(old.queryClient, old.accountQueries.passkeys()),
				runMutation(old.queryClient, old.billingMutations.checkoutPlan, {
					planId: 'retired',
				}),
			]);
			for (const result of retired) expect(result.error).not.toBeNull();
			expect(sent).toHaveLength(requestsBefore);
			expect<unknown>(
				current.queryClient.getQueryData(
					current.billingQueries.overview().queryKey,
				),
			).toEqual({ marker: 'new attachment' });
			expect(current.queryClient.getMutationCache().getAll()).toHaveLength(0);
		} finally {
			lateResponse.resolve(Response.json({}));
			for (const dashboard of dashboards) dashboard[Symbol.dispose]();
			auth[Symbol.dispose]();
		}
	});
}

test('every billing write refreshes reads, except a preview, which changes nothing', async () => {
	const account: Account = {
		authorityId: 'test-authority',
		principalId: asPrincipalId('alice'),
		baseURL: 'https://api.example.test',
		signal: new AbortController().signal,
		fetch: async () => Response.json({ marker: 'answer' }),
		getProfile: async () => Ok({ id: asPrincipalId('alice') }),
	};
	const dashboard = createDashboardRuntime(account);
	const { queryClient, billingQueries, billingMutations } = dashboard;
	const overview = billingQueries.overview();
	const invalidated = () =>
		queryClient.getQueryState(overview.queryKey)?.isInvalidated;
	try {
		expectOk(await runQuery(queryClient, overview));
		expectOk(
			await runMutation(queryClient, billingMutations.previewPlanChange, {
				planId: 'pro',
			}),
		);
		expect(invalidated()).toBe(false);
		expectOk(
			await runMutation(queryClient, billingMutations.checkoutTopUp, {
				successUrl: 'https://app.example.test',
			}),
		);
		expect(invalidated()).toBe(true);
	} finally {
		dashboard[Symbol.dispose]();
	}
});
