import type { Account } from '@epicenter/account';
import {
	MutationCache,
	matchQuery,
	QueryClient,
	type QueryKey,
} from '@tanstack/svelte-query';
import { resultMutations, resultQueries } from 'wellcrafted/query';
import { createAccountManagementClient } from '../auth/client.js';
import { createBillingApi } from '../billing/api.js';

declare module '@tanstack/svelte-query' {
	interface Register {
		/** The reads a write refreshes. Absent means every read; `[]` means none. */
		mutationMeta: { invalidates?: QueryKey[] };
	}
}

/**
 * One mounted dashboard attachment owns its transport clients and all caches.
 *
 * Reads and writes are native TanStack options over the captured clients,
 * keyed `[domain, method, args]`. Better Auth already answers `{ data, error }`,
 * so account reads expose its rows unmapped. The attachment's QueryClient
 * refreshes what is on screen after every write; a write that changes nothing
 * says so with `meta: { invalidates: [] }`.
 */
export function createDashboardRuntime(account: Account) {
	const lifetime = new AbortController();
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { staleTime: 30_000, refetchOnWindowFocus: true },
		},
		mutationCache: new MutationCache({
			onSettled: (_data, _error, _variables, _rollback, mutation, { client }) =>
				client.invalidateQueries({
					predicate: (query) =>
						mutation.meta?.invalidates?.some((queryKey) =>
							matchQuery({ queryKey }, query),
						) ?? true,
				}),
		}),
	});
	const management = createAccountManagementClient(account);
	const billingApi = createBillingApi(account);

	const billingQueries = resultQueries(['billing'], {
		overview: billingApi.overview,
		usage: billingApi.usage,
		events: billingApi.events,
		plans: billingApi.plans,
	});
	queryClient.setQueryDefaults(billingQueries.overview.key, {
		refetchOnWindowFocus: 'always',
	});

	const billingWrites = resultMutations(['billing'], {
		previewPlanChange: billingApi.previewPlanChange,
		checkoutPlan: billingApi.checkoutPlan,
		checkoutTopUp: billingApi.checkoutTopUp,
	});

	return {
		account,
		signal: lifetime.signal,
		queryClient,
		management,
		billingApi,
		billingQueries,
		billingMutations: {
			...billingWrites,
			/** A preview changes no billing state, so it refreshes nothing. */
			previewPlanChange: {
				...billingWrites.previewPlanChange,
				meta: { invalidates: [] },
			},
		},
		accountQueries: resultQueries(['account'], {
			session: () =>
				management.getSession({ query: { disableCookieCache: true } }),
			linked: () => management.listAccounts(),
			passkeys: () => management.passkey.listUserPasskeys(),
		}),
		accountMutations: resultMutations(['account'], {
			unlinkAccount: (input: { accountId: string }) =>
				management.unlinkAccount(input),
			addPasskey: () => management.passkey.addPasskey(),
			updatePasskey: (input: { id: string; name: string }) =>
				management.passkey.updatePasskey(input),
			deletePasskey: (input: { id: string }) =>
				management.passkey.deletePasskey(input),
		}),
		[Symbol.dispose]() {
			lifetime.abort();
			queryClient.clear();
		},
	};
}
