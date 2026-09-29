/**
 * Retired OAuth client tests
 *
 * Guards the deploy seed's revoke path: ids that left the trusted set stay
 * disabled instead of surviving as valid client metadata at /authorize and
 * /token. The seed upserts the trusted set and then disables this list, so
 * these tests pin the one invariant that makes that safe.
 *
 * Key behaviors:
 * - epicenter-cli stays on the retired list (the row seeded while the CLI existed)
 * - no retired id ever re-enters the trusted set
 */

import { describe, expect, test } from 'bun:test';
import {
	RETIRED_OAUTH_CLIENT_IDS,
	buildTrustedOAuthClients,
} from './oauth-seed.js';

describe('retired OAuth clients stay revoked', () => {
	test('epicenter-cli remains on the retired list', () => {
		expect([...RETIRED_OAUTH_CLIENT_IDS]).toContain('epicenter-cli');
	});

	test('no retired id appears in the trusted set', () => {
		const trustedIds: Set<string> = new Set(
			buildTrustedOAuthClients().map((client) => client.clientId),
		);
		for (const retiredId of RETIRED_OAUTH_CLIENT_IDS) {
			expect({ id: retiredId, trusted: trustedIds.has(retiredId) }).toEqual({
				id: retiredId,
				trusted: false,
			});
		}
	});
});
