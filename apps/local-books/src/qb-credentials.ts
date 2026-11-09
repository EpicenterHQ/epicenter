import type { QbEnvironment } from './config.ts';
import {
	type CredentialSource,
	type ProviderCredentialSpec,
	resolveProviderCredentials,
} from './provider-credentials.ts';

/**
 * QuickBooks provider-credential spec (ADR-0108), app-owned. QuickBooks issues a
 * whole distinct OAuth keyset per environment (Intuit's Development vs Production
 * apps register different redirect URIs and client ids), so both roles vary per
 * account and are environment-qualified:
 *
 *   QB_SANDBOX_CLIENT_ID     / QB_SANDBOX_CLIENT_SECRET      (Development keyset)
 *   QB_PRODUCTION_CLIENT_ID  / QB_PRODUCTION_CLIENT_SECRET   (Production keyset)
 *
 * The old undifferentiated `QB_CLIENT_ID` / `QB_CLIENT_SECRET` are retired: the
 * `--qb-env` flag now picks the keyset by name, so the wrong vault environment
 * can no longer substitute the wrong account's key. Which Infisical (or Wrangler)
 * environment stores a given qualified name is an orthogonal access-control
 * choice; the name, not the injection path, is the selector.
 */
export const QB_SPEC = {
	prefix: 'QB',
	environments: ['sandbox', 'production'],
	environmentRoles: ['CLIENT_ID', 'CLIENT_SECRET'],
} as const satisfies ProviderCredentialSpec<QbEnvironment>;

/**
 * Resolve the Intuit keyset for a target QuickBooks environment. Throws a
 * `ProviderCredentialError` naming the exact missing qualified variables when the
 * environment's keys are absent, so a flag/vault mismatch fails loudly at
 * resolution time instead of surfacing as an opaque Intuit redirect rejection
 * several calls later (the 2026-07-03 incident behind ADR-0108).
 */
export function resolveQbCredentials(
	environment: QbEnvironment,
	read?: CredentialSource,
): { clientId: string; clientSecret: string } {
	const credentials = resolveProviderCredentials(QB_SPEC, environment, read);
	return {
		clientId: credentials.CLIENT_ID,
		clientSecret: credentials.CLIENT_SECRET,
	};
}
