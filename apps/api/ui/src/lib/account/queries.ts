/**
 * TanStack Query bindings for the account page.
 *
 * Better Auth owns the account and passkey rows, and its client already returns
 * the `{ data, error }` shape Wellcrafted's `defineQuery` consumes, so these
 * queries expose those rows directly: there is no view model, the page reads
 * Better Auth fields at the point of use. Profile, provider, and passkey reads
 * all use the captured management client. The page invalidates a list key after
 * the matching link/unlink/passkey change.
 */

import { type createQueryFactories, defineKeys } from 'wellcrafted/query';
import type { createAccountManagementClient } from '../auth/client.js';

export const accountKeys = defineKeys({
	session: ['account', 'session'],
	linked: ['account', 'linked'],
	passkeys: ['account', 'passkeys'],
});

export function createAccountQueries(
	{ defineQuery }: Pick<ReturnType<typeof createQueryFactories>, 'defineQuery'>,
	authClient: ReturnType<typeof createAccountManagementClient>,
) {
	return {
		session: defineQuery({
			queryKey: accountKeys.session,
			queryFn: () =>
				authClient.getSession({ query: { disableCookieCache: true } }),
		}),
		linked: defineQuery({
			queryKey: accountKeys.linked,
			queryFn: () => authClient.listAccounts(),
		}),

		passkeys: defineQuery({
			queryKey: accountKeys.passkeys,
			queryFn: () => authClient.passkey.listUserPasskeys(),
		}),
	};
}
