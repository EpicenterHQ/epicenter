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
import { asPrincipalId, INSTANCE_PRINCIPAL_ID } from '@epicenter/identity';
import { attachHostDoName } from './principal.js';

const userPrincipal = asPrincipalId('abc');
const instance = INSTANCE_PRINCIPAL_ID;

describe('attachHostDoName', () => {
	test('per-user partitions an attach host under the user', () => {
		expect(attachHostDoName(userPrincipal, 'desktop')).toBe(
			'principals/abc/attach-hosts/desktop',
		);
	});

	test('instance partitions an attach host under the literal instance principal', () => {
		expect(attachHostDoName(instance, 'desktop')).toBe(
			'principals/instance/attach-hosts/desktop',
		);
	});
});
