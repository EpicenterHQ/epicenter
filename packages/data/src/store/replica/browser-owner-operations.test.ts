/**
 * Browser Runtime Owner Operation Tests
 *
 * Keeps expected record transitions and publication projection inside one
 * serialized elected-owner operation.
 *
 * Key behaviors:
 * - Terminal table/value mutations return typed outcomes without writing
 * - Terminal deletion is an idempotent owner-side no-op
 * - Publication status uses the shared cross-plane projection
 */
import { expect, test } from 'bun:test';

import type { RecordAddress } from '../../protocol/v1/index.js';
import type { BrowserReplicaOwner } from './browser-owner.js';
import { createBrowserReplicaOwnerOperations } from './browser-owner-operations.js';

const address: RecordAddress = {
	namespace: 'so.epicenter.runtime',
	collection: 'notes',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};

function setup({ live, terminal }: { live: boolean; terminal: boolean }) {
	let writes = 0;
	const store = {
		isVisiblyLive: () => live,
		record: () =>
			terminal
				? {
						confirmed: null,
						sealed: null,
						pending: { op: 'tombstone' },
						parked: null,
					}
				: null,
		localWrite: () => {
			writes += 1;
		},
		visibleRecord: () => ({ state: 'absent' as const }),
		inspectDocument: () => null,
	};
	const owner = {
		store,
		blobs: {
			inspect: () => ({ kind: 'absent' as const }),
		},
	} as unknown as BrowserReplicaOwner;
	return {
		operations: createBrowserReplicaOwnerOperations(owner),
		writes: () => writes,
	};
}

test('record mutations refuse terminal state without invoking localWrite', async () => {
	const fixture = setup({ live: false, terminal: true });

	expect(
		await fixture.operations.execute({
			kind: 'runtime-table-update',
			intent: { address, op: 'patch', set: {}, unset: [] },
		}),
	).toEqual({ kind: 'record-not-live' });
	expect(
		await fixture.operations.execute({
			kind: 'runtime-value-write',
			intent: { address, op: 'replace', value: 'value' },
		}),
	).toEqual({ kind: 'record-not-live' });
	expect(
		await fixture.operations.execute({
			kind: 'runtime-delete-record',
			address,
		}),
	).toBeUndefined();
	expect(fixture.writes()).toBe(0);
});

test('publication status is projected once from the owner store and blob state', async () => {
	const fixture = setup({ live: false, terminal: false });

	expect(
		await fixture.operations.execute({ kind: 'publication-status', address }),
	).toEqual({ state: 'settled' });
});
