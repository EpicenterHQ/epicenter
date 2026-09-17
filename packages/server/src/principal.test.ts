/**
 * Partition derivations: every durable string for per-user and instance topologies.
 *
 * The point of these tests is to pin the durable namespace target. There is
 * no compatibility exception for the legacy owner-named shape; the clean-break target
 * is principals/ everywhere new durable server state is addressed.
 *
 * Per-user and instance topologies share the same shape; in the per-user topology
 * `principalId` is the signed-in user's id, on an instance it is the literal
 * `'instance'`.
 */

import { describe, expect, test } from 'bun:test';
import { asPrincipalId, INSTANCE_PRINCIPAL_ID } from '@epicenter/principal';
import { storeAuthorityName } from './principal.js';

const userPrincipal = asPrincipalId('abc');
const instance = INSTANCE_PRINCIPAL_ID;

describe('storeAuthorityName', () => {
	test('the resource segment is data, a sibling of blobs (ADR-0276)', () => {
		expect(
			storeAuthorityName(userPrincipal, 'so.epicenter.honeycrisp', 3),
		).toBe('principals/abc/data/so.epicenter.honeycrisp/generations/3');
	});

	test('an instance addresses one authority under the literal instance principal', () => {
		expect(storeAuthorityName(instance, 'so.epicenter.honeycrisp', 1)).toBe(
			'principals/instance/data/so.epicenter.honeycrisp/generations/1',
		);
	});

	test('two generations of one database are two objects (ADR-0292)', () => {
		// The whole of membership. A replica addressed at generation 3 cannot
		// reach generation 4's bytes however its dial is written, which is what
		// retired the document identity stamp.
		expect(
			storeAuthorityName(userPrincipal, 'so.epicenter.honeycrisp', 3),
		).not.toBe(storeAuthorityName(userPrincipal, 'so.epicenter.honeycrisp', 4));
	});
});
