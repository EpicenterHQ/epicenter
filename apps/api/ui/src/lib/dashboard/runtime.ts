import type { Account } from '@epicenter/auth';
import { QueryClient } from '@tanstack/svelte-query';
import { createQueryFactories } from 'wellcrafted/query';
import { createAccountQueries } from '../account/queries.js';
import { createAccountManagementClient } from '../auth/client.js';
import { createBillingApi } from '../billing/api.js';
import { createBillingQueries } from '../billing/queries.js';

/** One mounted dashboard attachment owns its transport clients and all caches. */
export function createDashboardRuntime(account: Account) {
	const lifetime = new AbortController();
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { staleTime: 30_000, refetchOnWindowFocus: true },
		},
	});
	const queries = createQueryFactories(queryClient);
	const management = createAccountManagementClient(account);
	const billingApi = createBillingApi(account);
	return {
		account,
		signal: lifetime.signal,
		queryClient,
		management,
		billingApi,
		billing: createBillingQueries(queries, billingApi),
		accountQueries: createAccountQueries(queries, management),
		[Symbol.dispose]() {
			lifetime.abort();
			queryClient.clear();
		},
	};
}
