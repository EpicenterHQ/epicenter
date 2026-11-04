/**
 * Provider credential resolution mechanism (ADR-0105).
 *
 * Fixtures are declared inline: the shared package owns only the mechanism, so
 * app specs such as `QB_SPEC` live in their apps, not here. These
 * fixtures mirror their real shapes to pin the naming convention: a role that
 * varies per account is env-qualified, a shared role is not, a single-environment
 * provider drops the env segment, and a missing name throws by exact name.
 */

import { expect, test } from 'bun:test';
import {
	ProviderCredentialError,
	type ProviderCredentialSpec,
	resolveProviderCredentials,
	specToEnvExampleLines,
} from './provider-credentials.ts';

// Two accounts, both roles differ per keyset (QuickBooks shape).
const TWO_ENV_SPEC = {
	prefix: 'QB',
	environments: ['sandbox', 'production'],
	environmentRoles: ['CLIENT_ID', 'CLIENT_SECRET'],
} as const satisfies ProviderCredentialSpec<'sandbox' | 'production'>;

// One account: the env segment is dropped even for an environmentRole.
const ONE_ENV_SPEC = {
	prefix: 'SOLO',
	environments: ['production'],
	environmentRoles: ['CLIENT_ID', 'CLIENT_SECRET'],
} as const satisfies ProviderCredentialSpec<'production'>;

// Shared client_id, per-environment secret (Plaid shape).
const SHARED_ROLE_SPEC = {
	prefix: 'PLAID',
	environments: ['sandbox', 'development', 'production'],
	sharedRoles: ['CLIENT_ID'],
	environmentRoles: ['SECRET'],
} as const satisfies ProviderCredentialSpec<
	'sandbox' | 'development' | 'production'
>;

/** Read from a fixed map instead of process.env. */
const readFrom =
	(map: Record<string, string>) =>
	(name: string): string | undefined =>
		map[name];

test('multi-environment provider reads env-qualified names', () => {
	const creds = resolveProviderCredentials(
		TWO_ENV_SPEC,
		'sandbox',
		readFrom({
			QB_SANDBOX_CLIENT_ID: 'sand-id',
			QB_SANDBOX_CLIENT_SECRET: 'sand-secret',
			// The production keyset is present but must not leak into a sandbox read.
			QB_PRODUCTION_CLIENT_ID: 'prod-id',
			QB_PRODUCTION_CLIENT_SECRET: 'prod-secret',
		}),
	);
	expect(creds).toEqual({ CLIENT_ID: 'sand-id', CLIENT_SECRET: 'sand-secret' });

	const prod = resolveProviderCredentials(
		TWO_ENV_SPEC,
		'production',
		readFrom({
			QB_PRODUCTION_CLIENT_ID: 'prod-id',
			QB_PRODUCTION_CLIENT_SECRET: 'prod-secret',
		}),
	);
	expect(prod).toEqual({ CLIENT_ID: 'prod-id', CLIENT_SECRET: 'prod-secret' });
});

test('single-environment provider reads unqualified names', () => {
	const creds = resolveProviderCredentials(
		ONE_ENV_SPEC,
		'production',
		readFrom({ SOLO_CLIENT_ID: 'id', SOLO_CLIENT_SECRET: 'secret' }),
	);
	expect(creds).toEqual({ CLIENT_ID: 'id', CLIENT_SECRET: 'secret' });
});

test('shared role stays unqualified while the per-env role qualifies', () => {
	const creds = resolveProviderCredentials(
		SHARED_ROLE_SPEC,
		'sandbox',
		readFrom({
			PLAID_CLIENT_ID: 'one-id-for-all',
			PLAID_SANDBOX_SECRET: 'sand-secret',
		}),
	);
	expect(creds).toEqual({ CLIENT_ID: 'one-id-for-all', SECRET: 'sand-secret' });
});

test('missing variables throw naming the exact qualified names', () => {
	let thrown: unknown;
	try {
		resolveProviderCredentials(TWO_ENV_SPEC, 'production', readFrom({}));
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(ProviderCredentialError);
	const message = (thrown as Error).message;
	expect(message).toContain('QB_PRODUCTION_CLIENT_ID');
	expect(message).toContain('QB_PRODUCTION_CLIENT_SECRET');
	// An empty string is as absent as undefined: a blank secret is still missing.
	expect(() =>
		resolveProviderCredentials(
			TWO_ENV_SPEC,
			'sandbox',
			readFrom({ QB_SANDBOX_CLIENT_ID: '', QB_SANDBOX_CLIENT_SECRET: 'ok' }),
		),
	).toThrow('QB_SANDBOX_CLIENT_ID');
});

test('specToEnvExampleLines emits exactly the resolver names, empty-valued', () => {
	const lines = specToEnvExampleLines(SHARED_ROLE_SPEC);
	const names = lines
		.filter((line) => /^[A-Z0-9_]+=$/.test(line))
		.map((line) => line.slice(0, -1));
	expect(names).toEqual([
		'PLAID_CLIENT_ID',
		'PLAID_SANDBOX_SECRET',
		'PLAID_DEVELOPMENT_SECRET',
		'PLAID_PRODUCTION_SECRET',
	]);
});
