import type { Account } from '@epicenter/account';
import { MutationCache, QueryClient } from '@tanstack/svelte-query';
import { resultMutations, resultQueries } from 'wellcrafted/query';
import { createAccountManagementClient } from '../auth/client.js';
import { createBillingApi } from '../billing/api.js';

/**
 * One mounted dashboard attachment owns its transport clients and all caches.
 *
 * Reads and writes are native TanStack options over the captured clients,
 * keyed `[domain, method, args]`. Better Auth already answers `{ data, error }`,
 * so account reads expose its rows unmapped. The attachment's QueryClient
 * refreshes what is on screen after every write. A plan-change preview is a
 * read: it changes nothing, and its answer depends on the current plan.
 */
export function createDashboardRuntime(account: Account) {
	const lifetime = new AbortController();
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { staleTime: 30_000, refetchOnWindowFocus: true },
		},
		mutationCache: new MutationCache({
			onSettled: (
				_data,
				_error,
				_variables,
				_rollback,
				_mutation,
				{ client },
			) => client.invalidateQueries(),
		}),
	});
	const management = createAccountManagementClient(account);
	const billingApi = createBillingApi(account);

	const billingQueries = resultQueries(['billing'], {
		overview: billingApi.overview,
		usage: billingApi.usage,
		events: billingApi.events,
		plans: billingApi.plans,
		previewPlanChange: billingApi.previewPlanChange,
	});
	queryClient.setQueryDefaults(billingQueries.overview.key, {
		refetchOnWindowFocus: 'always',
	});

	return {
		account,
		signal: lifetime.signal,
		queryClient,
		management,
		billingApi,
		billingQueries,
		billingMutations: resultMutations(['billing'], {
			checkoutPlan: billingApi.checkoutPlan,
			checkoutTopUp: billingApi.checkoutTopUp,
		}),
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
