/**
 * What an authority still holds after you delete something, and for how long.
 *
 * This file has been rewritten twice, and the reason is worth stating because
 * it is the hazard evidence files have: it kept passing while describing a
 * system that was not deployed. Its first claim was about the positional log,
 * ADR-0277 replaced that log with a document-holding server, and the file was
 * rewritten to measure the replacement. ADR-0298 deleted the replacement,
 * which was never routed to anything, so the positional log is the shipped
 * design again and this measures it again.
 *
 * The claim, and it is not a comfortable one: **a byte-blind authority
 * retains deleted content, and a fresh device is sent it.** The authority
 * stores opaque updates and forwards them, so the update that created a row
 * is still a row in the log after the row is deleted, and catch-up from
 * position zero replays it. Nothing on the server collects it, because
 * collecting requires reading the bytes.
 *
 * What removes it is the SNAPSHOT, and the snapshot comes from a client. A
 * client encodes its own garbage-collected document and offers it; the
 * authority verifies only that the connection was sent through the offered
 * position, replaces the snapshot, and forgets every entry the snapshot
 * covers. So retention is bounded by snapshot cadence, and the party that
 * does the collecting is the one that can read the bytes.
 *
 * Evidence for `shouldSnapshot`, for `replaceSnapshot`, and for what ADR-0298
 * accepts by keeping the authority blind. Not a product workflow.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';

import {
	openSyncAuthority,
	type SyncAuthority,
} from '../../src/data/sync/authority.js';

const CANARY = 'a sentence somebody deleted on purpose';

function authority() {
	const sqlite = createBunSqliteAdapter(new Database(':memory:'));
	return {
		held: openSyncAuthority({
			sqlite,
			// Every snapshot here is asked for explicitly, so the floor must not
			// decline one on a document this small.
			snapshotFloorBytes: 0,
		}),
		/** Everything in storage, as text. Evidence reaches past the surface. */
		storage: () =>
			[
				...sqlite.all<{ bytes: Uint8Array | ArrayBuffer }>(
					'SELECT bytes FROM _log ORDER BY seq, chunk',
				),
				...sqlite.all<{ bytes: Uint8Array | ArrayBuffer }>(
					'SELECT bytes FROM _snapshot ORDER BY position, chunk',
				),
			]
				.map((row) => decode(new Uint8Array(row.bytes as ArrayBuffer)))
				.join(''),
	};
}

function decode(bytes: Uint8Array): string {
	return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** Everything a device holding nothing would be sent, as text. */
function everythingSentToANewDevice(held: SyncAuthority): string {
	const snapshot = expectOk(held.snapshot());
	const entries = expectOk(held.since(expectOk(held.snapshotPosition())));
	return [
		...(snapshot === undefined ? [] : [snapshot.bytes]),
		...entries.map((entry) => entry.bytes),
	]
		.map(decode)
		.join('');
}

describe('what a deletion leaves behind', () => {
	test('storage and the wire both carry deleted content until a snapshot', () => {
		const { held, storage } = authority();
		const doc = new Y.Doc({ gc: true });

		doc.transact(() =>
			doc.get('notes').setAttr('body' as never, CANARY as never),
		);
		expectOk(held.append(new Uint8Array(Y.encodeStateAsUpdateV2(doc))));

		const afterWrite = Y.encodeStateVector(doc);
		doc.transact(() => doc.get('notes').deleteAttr('body'));
		expectOk(
			held.append(new Uint8Array(Y.encodeStateAsUpdateV2(doc, afterWrite))),
		);

		// The update that CREATED the row is still an entry, so the sentence is
		// on the server's disk after it was deleted.
		expect(storage()).toContain(CANARY);

		// And unlike a document-holding authority, it is also on the WIRE: a
		// device joining now replays from position zero and is handed the
		// creation before the deletion. Nothing on the server collects it,
		// because collecting means reading the bytes, and the authority does
		// not (ADR-0298). This is the cost blindness actually has, stated.
		expect(everythingSentToANewDevice(held)).toContain(CANARY);

		// The client is the party that can collect, so the client is the party
		// that does. It encodes its own garbage-collected document and offers
		// it at the position it was sent through.
		const collected = new Uint8Array(Y.encodeStateAsUpdateV2(doc));
		expect(decode(collected)).not.toContain(CANARY);
		expectOk(held.replaceSnapshot(expectOk(held.head()), collected));

		// The snapshot forgets every entry it covers, so both storage and the
		// wire catch up with what the client already knew.
		expect(storage()).not.toContain(CANARY);
		expect(everythingSentToANewDevice(held)).not.toContain(CANARY);
		doc.destroy();
	});

	test('a fresh device is sent the snapshot plus the tail after it', () => {
		const { held } = authority();
		const doc = new Y.Doc({ gc: true });
		// Ten separate updates, so a log with no snapshot has ten entries to
		// replay and one with a snapshot has one value plus what followed.
		for (let index = 0; index < 10; index += 1) {
			const before = Y.encodeStateVector(doc);
			doc.transact(() =>
				doc.get('notes').setAttr(`k${index}` as never, index as never),
			);
			expectOk(
				held.append(new Uint8Array(Y.encodeStateAsUpdateV2(doc, before))),
			);
		}
		expect(expectOk(held.since(0))).toHaveLength(10);

		expectOk(
			held.replaceSnapshot(
				expectOk(held.head()),
				new Uint8Array(Y.encodeStateAsUpdateV2(doc)),
			),
		);
		expect(expectOk(held.since(expectOk(held.snapshotPosition())))).toEqual([]);

		// And what it replays to is the same document either way, which is the
		// only thing a replica is owed.
		const fresh = new Y.Doc({ gc: true });
		const snapshot = expectOk(held.snapshot());
		if (snapshot === undefined) throw new Error('the snapshot should be held');
		Y.applyUpdateV2(fresh, snapshot.bytes as Uint8Array<ArrayBuffer>);
		expect(Object.keys(fresh.get('notes').getAttrs() ?? {})).toHaveLength(10);
		fresh.destroy();
		doc.destroy();
	});

	test('a caught-up device is sent nothing at all', () => {
		const { held } = authority();
		const doc = new Y.Doc({ gc: true });
		doc.transact(() => doc.get('notes').setAttr('a' as never, 1 as never));
		expectOk(held.append(new Uint8Array(Y.encodeStateAsUpdateV2(doc))));

		// The whole of what a replica owes when it owes nothing: an integer
		// comparison, not a state vector to encode and diff against.
		expect(expectOk(held.since(expectOk(held.head())))).toEqual([]);
		doc.destroy();
	});
});
