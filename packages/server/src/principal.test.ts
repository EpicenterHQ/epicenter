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
import { generateBlobId } from '@epicenter/blobs';
import { asPrincipalId, INSTANCE_PRINCIPAL_ID } from '@epicenter/identity';
import { blobKey, blobPrincipalPrefix } from './principal.js';

const userPrincipal = asPrincipalId('abc');
const instance = INSTANCE_PRINCIPAL_ID;

describe('blobKey', () => {
	test('per-user partitions blob objects under the user', () => {
		const id = generateBlobId();
		expect(blobKey(userPrincipal, id)).toBe(`principals/abc/blobs/${id}`);
	});

	test('instance partitions blob objects under the literal instance principal', () => {
		const id = generateBlobId();
		expect(blobKey(instance, id)).toBe(`principals/instance/blobs/${id}`);
	});
});

describe('blobPrincipalPrefix', () => {
	test('per-user blob listings keep the principals prefix', () => {
		expect(blobPrincipalPrefix(userPrincipal)).toBe('principals/abc/blobs/');
	});

	test('instance blob listings keep the principals prefix', () => {
		expect(blobPrincipalPrefix(instance)).toBe('principals/instance/blobs/');
	});
});
