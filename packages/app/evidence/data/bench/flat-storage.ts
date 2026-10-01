import { defineStore, defineTable, field, plainText } from '@epicenter/app';
/**
 * What the authority's storage actually tracks.
 *
 * Run: `bun run evidence/bench/flat-storage.ts`
 *
 * ADR-0220 first claimed that replacing the log with a snapshot and a tail makes
 * storage CONSTANT. This bench was written to check that and the claim did not
 * survive it, which is the specific failure this corpus keeps catching in its
 * own records: the never-compacted log was priced at 4 MB a year and the real
 * bill turned out to be something else entirely.
 *
 * Storage is not constant. A snapshot is current state, and current state
 * carries the accumulated DELETE SET, so the authority holds live rows plus
 * roughly one tombstone per row ever deleted. It grows with lifetime deletions
 * rather than with the operation count, which is a real improvement over an
 * append-only log and is not the same as flat.
 *
 * The shape here is a working vault: rows are created, edited and deleted
 * continuously, so the live set stays roughly flat while the number of
 * operations grows without bound. If the claim holds, stored bytes settle and
 * the tail keeps getting cut; if it does not, the line climbs.
 *
 * The CONTROL is the same run with snapshots switched off, which must climb. A
 * table where both columns are flat would mean the workload was too small to
 * show anything, and a bench that cannot fail is decoration.
 */

import { Database } from 'bun:sqlite';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import {
	openAccountStore,
	syncEngineOf,
} from '../../../src/data/store/store.js';
import { openSyncAuthority } from '../../../src/data/sync/authority.js';

const evidenceDatabase = defineStore({
	id: 'so.epicenter.honeycrisp',
	kv: {},
	tables: {
		notes: defineTable({
			fields: {
				title: field.string(),
			},
			body: plainText(),
		}),
	},
});

/** Roughly the live size of a working vault. */
const LIVE_ROWS = 300;
const CHECKPOINT_EVERY = 500;
const OPERATIONS = 6_000;

async function openReplica() {
	const db = await openAccountStore({
		definition: evidenceDatabase,
		sqlite: createBunSqliteAdapter(new Database(':memory:')),
	});
	return { store: db, db };
}

/**
 * One run: a device working continuously against one authority.
 *
 * `snapshots` off is the control. With it off the authority is ADR-0217's
 * append-only log, so the two columns are the two designs measured against the
 * identical workload rather than against each other's benchmarks.
 */
async function run({ snapshots }: { snapshots: boolean }) {
	const authority = openSyncAuthority({
		sqlite: createBunSqliteAdapter(new Database(':memory:')),
		// Low enough that a bench-sized vault reaches the snapshot path at all.
		snapshotFloorBytes: 16 * 1024,
	});
	const { store, db } = await openReplica();
	const alive: string[] = [];
	const samples: { operations: number; stored: number; tail: number }[] = [];

	for (let operation = 1; operation <= OPERATIONS; operation += 1) {
		if (alive.length < LIVE_ROWS) {
			const made = db.tables.notes.create({ title: `note ${operation}` });
			alive.push(made.id);
		} else if (operation % 3 === 0) {
			// Retire the oldest and make a new one, so the live set stays flat
			// while the operation count does not.
			const victim = alive.shift() as string;
			db.tables.notes.delete(victim);
		} else {
			const target = alive[operation % alive.length] as string;
			const edited = db.tables.notes.update(target, {
				title: `note ${operation}`,
			});
			if (edited.error !== null) throw edited.error;
		}

		await store.persistence.flush();
		const owed = syncEngineOf(store).coalesce();
		if (owed !== undefined) {
			const position = authority.append(owed.bytes);
			if (position.error !== null) throw position.error;
			syncEngineOf(store).acknowledge(owed.id, position.data);
		}

		if (snapshots) {
			const wanted = authority.shouldSnapshot();
			if (wanted.error !== null) throw wanted.error;
			if (wanted.data) {
				// The replica is at the head here by construction, which is the
				// condition the hub checks on a real connection.
				const head = authority.head();
				if (head.error !== null) throw head.error;
				const replaced = authority.replaceSnapshot(
					head.data,
					store.encodeStateSince(),
				);
				if (replaced.error !== null) throw replaced.error;
			}
		}

		if (operation % CHECKPOINT_EVERY === 0) {
			const stored = authority.storedBytes();
			const tail = authority.since(0, 1_000_000);
			if (stored.error !== null || tail.error !== null)
				throw new Error('read failed');
			samples.push({
				operations: operation,
				stored: stored.data,
				tail: tail.data.length,
			});
		}
	}

	const rows = db.tables.notes.ids();
	return { samples, liveRows: rows.length };
}

const withSnapshots = await run({ snapshots: true });
const control = await run({ snapshots: false });

console.log(
	`a working vault of about ${LIVE_ROWS} live rows, created, edited and deleted continuously\n`,
);
console.log(
	`  ${'operations'.padStart(11)} ${'snapshot+tail'.padStart(14)} ${'tail'.padStart(6)} ${'append-only log'.padStart(16)} ${'growth'.padStart(8)}`,
);
for (const [index, sample] of withSnapshots.samples.entries()) {
	const logged = control.samples[index];
	const mb = (bytes: number) =>
		bytes >= 1048576
			? `${(bytes / 1048576).toFixed(1)} MB`
			: `${Math.round(bytes / 1024)} KB`;
	console.log(
		`  ${sample.operations.toLocaleString().padStart(11)} ${mb(sample.stored).padStart(14)} ${String(sample.tail).padStart(6)} ${mb(logged?.stored ?? 0).padStart(16)} ${`${((logged?.stored ?? 1) / Math.max(sample.stored, 1)).toFixed(1)}x`.padStart(8)}`,
	);
}

const snapshotFirst = withSnapshots.samples[0]?.stored ?? 0;
const snapshotLast = withSnapshots.samples.at(-1)?.stored ?? 0;
const controlFirst = control.samples[0]?.stored ?? 0;
const controlLast = control.samples.at(-1)?.stored ?? 0;

console.log('\n  CONTROLS');
const report = (held: boolean, label: string) =>
	console.log(`    ${held ? 'held  ' : 'FAILED'}  ${label}`);
// The honest claim: it grows more slowly than the log, and the gap widens.
const early =
	(control.samples[1]?.stored ?? 1) /
	Math.max(withSnapshots.samples[1]?.stored ?? 1, 1);
const late = controlLast / Math.max(snapshotLast, 1);
report(
	late > early,
	`the gap widens rather than closing (${early.toFixed(1)}x early, ${late.toFixed(1)}x late)`,
);
report(
	snapshotLast < controlLast,
	`snapshot+tail stays under the log (${Math.round(snapshotLast / 1024)} KB against ${Math.round(controlLast / 1024)} KB)`,
);
// And the part that is NOT flat, stated rather than hidden.
console.log(
	`\n  storage is NOT constant: ${Math.round(snapshotFirst / 1024)} KB to ${Math.round(snapshotLast / 1024)} KB over ${OPERATIONS.toLocaleString()} operations.`,
);
console.log(
	'  A snapshot is current state, and current state carries the delete set, so',
);
console.log(
	'  what it tracks is live rows plus one tombstone per row ever deleted.',
);
// Without which the line above proves nothing: the workload has to be big
// enough that an append-only log visibly climbs on it.
report(
	controlLast > controlFirst * 5,
	`the append-only control climbs (${Math.round(controlFirst / 1024)} KB to ${Math.round(controlLast / 1024)} KB)`,
);
report(
	withSnapshots.liveRows === control.liveRows,
	`both runs end with the same ${withSnapshots.liveRows} live rows`,
);
