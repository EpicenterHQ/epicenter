/**
 * Test-only: the worker `vitest` mounts for the store transport.
 *
 * `StoreAuthority` and `mountStoreSyncApp` are the deployed ones, imported
 * rather than redefined, so what the test drives is what `wrangler deploy`
 * ships. The only substitution is the bearer resolver, and it is the narrowest
 * one that still exercises the real gate: `Bearer device:<principalId>` resolves
 * a synthetic principal, exactly as `apps/api/dev-auth.ts` does for the parity
 * smoke, so what is NOT under test here is Better Auth, and what IS under test
 * is everything the store transport added.
 */
import { Hono } from 'hono';
import {
	type GenerationsLedgerStub,
	mountStoreSyncApp,
	type StoreAuthorityStub,
} from '../src/store-sync/mount.js';
import type { Env, ResolveBearerPrincipal } from '../src/types.js';

export { StoreAuthority } from '../src/store-sync/authority.js';
export { GenerationsLedger } from '../src/store-sync/generations.js';
export { StoreTestReplica } from './replica.js';

/** `device:<principalId>` and nothing else. Anything unrecognised is refused. */
const resolveTestPrincipal: ResolveBearerPrincipal<Env> = async (
	_c,
	bearer,
) => {
	const principalId = bearer.startsWith('device:') ? bearer.slice(7) : '';
	if (principalId === '') {
		return {
			data: null,
			error: { name: 'InvalidToken', message: 'no principal' },
		} as never;
	}
	return { data: { id: principalId }, error: null } as never;
};

const app = new Hono<Env>();
mountStoreSyncApp(app, {
	resolveBearerPrincipal: resolveTestPrincipal,
	resolveStore: (env) => {
		const bindings = env as unknown as {
			STORE_AUTHORITY: DurableObjectNamespace;
			GENERATIONS_LEDGER: DurableObjectNamespace;
		};
		return {
			authority: (name) =>
				bindings.STORE_AUTHORITY.get(
					bindings.STORE_AUTHORITY.idFromName(name),
				) as unknown as StoreAuthorityStub,
			ledger: (name) =>
				bindings.GENERATIONS_LEDGER.get(
					bindings.GENERATIONS_LEDGER.idFromName(name),
				) as unknown as GenerationsLedgerStub,
		};
	},
});

export default { fetch: app.fetch };
