import { defineStore, defineTable, field, plainText } from '@epicenter/app';
/**
 * What a brand-new device pays to join a vault that has been lived in.
 *
 * Run: `bun run evidence/bench/first-sync.ts`
 *
 * ADR-0220 claims a returning or brand-new replica downloads CURRENT STATE PLUS
 * A SHORT TAIL rather than all history. Nothing measured it. That matters here
 * more than usual, because the neighbouring claim in the same record, that
 * replacing the log with a snapshot makes storage CONSTANT, did not survive
 * `evidence/bench/flat-storage.ts`: a snapshot carries the accumulated delete
 * set, so storage tracks lifetime deletions rather than staying flat. A record
 * that was wrong once about the storage axis is worth checking on the join axis.
 *
 * The workload is a vault that has been USED, not one that was just created:
 * 986 notes with 2.8 KB body text (the real vault's shape, the same corpus
 * `never-compact.ts` and `memory.ts` build), then N days of typing, renaming,
 * deleting and creating on top. History behind the current state is the entire
 * point; a freshly created vault cannot distinguish the two designs at all.
 *
 * The control column is produced by simply never snapshotting, which is what
 * ADR-0217 specified. So the two columns are the two DESIGNS over one identical
 * workload, not two benchmarks with different corpora.
 *
 * METHOD, which this directory enforces:
 *
 *   - ONE OS PROCESS PER MEASURED CASE, for the reason `memory.ts` spells out.
 *     Several shapes in one process report the allocator's high-water mark for
 *     the first and near zero after; an earlier bench here returned NEGATIVE
 *     heap deltas because of exactly that. Timing has the same problem in a
 *     milder form, since a warmed JIT and a heap full of the previous case's
 *     garbage are not the arriving phone's conditions.
 *   - Building and measuring are also separate processes. The build process
 *     replays days of edits and writes the exact bytes the hub would send a
 *     cursor-0 connection to a file; the measuring process reads that file into
 *     an empty replica and times the apply. Building in-process would put the
 *     resident replica's whole document in the same heap as the arriving one.
 *   - EVERY CASE CARRIES A CONTROL THAT FAILS IF THE TEST IS NOT LIVE. The
 *     arriving replica must END UP WITH THE VAULT: its live row count, and one
 *     named note's title and full body text read back out of its content node.
 *     A run that transferred nothing would otherwise post the best numbers on
 *     the table. There is also a negative control at the bottom, an arrival
 *     given an empty payload, which must FAIL that verification.
 *   - The snapshot floor is the shipped 64 KB. Nothing is injected, because a
 *     real-sized vault is two orders of magnitude above the floor and the ratio
 *     rule is what actually governs. The tests inject a floor; a bench at real
 *     scale must not, or it measures a policy nobody runs.
 *
 * Anything not measured is printed as not measured.
 *
 * ## What it found, so nobody has to run it to know
 *
 * The claim does not survive in the form ADR-0220 states it. "A short tail" is
 * not what a joining device gets. The tail is bounded, which is the real and
 * worthwhile difference from an append-only log, but the bound is roughly TWICE
 * the current state rather than something small, so a new phone pays between one
 * and three times the vault for its first sync depending on when in the cycle it
 * arrives.
 *
 * The mechanism is visible in the table and is not the one the policy comment
 * describes. `shouldSnapshot` compares the tail against `sumBytes('_snapshot')`,
 * and the authority retains TWO snapshot positions so that a bad snapshot has a
 * way back, so the number the tail has to beat is the sum of both retained
 * snapshots rather than the live one. `authority.ts` says the trigger "bounds
 * both at about twice the state"; measured, it bounds the tail alone at about
 * twice the state and the transfer at about three times it.
 *
 * The consequence is that replacements are RARE at real scale. Over 240
 * simulated days on this corpus the snapshot moved exactly once after the vault
 * was created, at day 48 or so. Between replacements the snapshot design decays
 * back toward the log: just after a replacement it costs a joining device 2.9x
 * fewer entries and 2.7x less time than the log, and six months later that is
 * down to 17 percent fewer entries and 13 percent less time. The number to quote
 * is not an average, it is a sawtooth, and where a device lands on it is luck.
 *
 * Time and bytes do not move together, which is the other reason to report both.
 * Applying is per ENTRY, at a flat 2.3 to 2.8 ms each, because every entry is
 * one commit on the arriving device. So the snapshot design's advantage is
 * mostly in entry count and only slightly in bytes: the 60-day row transfers 14
 * percent fewer bytes than its control and takes 64 percent less time.
 *
 * Running it takes about six minutes, nearly all of it replaying histories in
 * the build processes. That is the cost of a corpus at real scale rather than a
 * tuned-down one, and it is not a measurement of anything.
 */

import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import {
	openAccountStore,
	syncEngineOf,
} from '../../../src/data/store/store.js';
import { openSyncAuthority } from '../../../src/data/sync/authority.js';

const benchDatabase = defineStore({
	id: 'so.epicenter.honeycrisp',
	kv: {},
	tables: {
		notes: defineTable({
			title: field.string(),
			content: plainText(),
		}),
	},
});

/** The real vault's shape, the same one the other benches in here model. */
const NOTES = 986;
const BODY_CHARS = 2800;

/**
 * One day of use, as transactions a real content would dispatch.
 *
 * Typing is per keystroke because ProseMirror dispatches that way. The churn is
 * the part `never-compact.ts` did not have and this bench needs: a snapshot is
 * current state, so deletions are the one thing it can forget and the one thing
 * a log cannot, and a workload without them would flatter the snapshot column.
 *
 * The two contribute very unevenly, which is worth knowing before reading the
 * table. Measured on this corpus, a typed character costs about 2.3 bytes of
 * log after the client's merge, so 500 characters is roughly 1.2 KB a day;
 * creating one 2.8 KB note costs about 2.9 KB. Churn dominates. Rescale from
 * those two numbers rather than assuming the day below is the only shape.
 */
const DAY = {
	fieldEdits: 20,
	charsTyped: 500,
	notesDeleted: 4,
	notesCreated: 4,
};

/**
 * Transactions coalesced into one appended entry.
 *
 * The client merges its own unsent updates on an idle timer, so the log grows
 * with SENDS rather than with transactions. Forty is roughly a send per second
 * of sustained typing, which is `never-compact.ts`'s "per second" policy and the
 * one a real content's debounce produces.
 */
const SEND_EVERY = 40;

/**
 * How much history to put behind the current state, in days.
 *
 * Several points rather than one, because the claim under test is about SHAPE:
 * one column should track current state and the other total history, and a
 * single measurement cannot tell those apart. The range has to be long enough
 * to contain at least one snapshot replacement after the vault's creation,
 * which on this corpus lands around two months in.
 */
const DAY_SAMPLES = [0, 30, 60, 120, 240];

/** The note the arriving replica has to prove it actually received. */
const CANARY_MARKER = 'CANARY-first-sync-a-note-nobody-edits ';

type Mode = 'snapshot' | 'log';

type BuildReport = {
	days: number;
	mode: Mode;
	/** What the hub would put on the wire for a connection at cursor zero. */
	transferBytes: number;
	/** Frames-worth of work: the snapshot counts as one, then every tail entry. */
	entries: number;
	snapshotBytes: number;
	tailBytes: number;
	tailEntries: number;
	/** What the authority is holding, which is a different question and a known one. */
	storedBytes: number;
	head: number;
	/** Where the live snapshot sits, which is when the last replacement happened. */
	snapshotPosition: number;
	liveRows: number;
	canaryTitle: string;
	/** Read back off the RESIDENT replica, so the arrival is compared to a peer. */
	canaryText: string;
	buildMs: number;
};

type ApplyReport = {
	applyMs: number;
	appliedBytes: number;
	appliedEntries: number;
	verified: boolean;
	/** Why verification failed, so a bad run says what it saw rather than just 'no'. */
	saw: string;
};

// ---------------------------------------------------------------------------
// Build: replay a lived-in vault and write down exactly what a joiner is sent.
// ---------------------------------------------------------------------------

function bodyText(index: number): string {
	return `note ${index} `.padEnd(BODY_CHARS, 'x');
}

async function build(
	days: number,
	mode: Mode,
): Promise<{
	report: Omit<BuildReport, 'buildMs'>;
	payload: Uint8Array[];
}> {
	const authority = openSyncAuthority({
		sqlite: createBunSqliteAdapter(new Database(':memory:')),
	});
	const db = await openAccountStore({
		definition: benchDatabase,
		sqlite: createBunSqliteAdapter(new Database(':memory:')),
	});
	const store = db;

	let sinceSend = 0;
	/** Hand everything unsent to the authority, exactly as the client does. */
	const send = async () => {
		await store.persistence.flush();
		const owed = syncEngineOf(store).coalesce();
		if (owed === undefined) return;
		const position = authority.append(owed.bytes);
		if (position.error !== null) throw position.error;
		syncEngineOf(store).acknowledge(owed.id, position.data);
		if (mode === 'log') return;
		// The snapshot half. The resident replica is at the head by construction,
		// which is the condition the hub checks on a real connection before it asks
		// anyone for a snapshot.
		const wanted = authority.shouldSnapshot();
		if (wanted.error !== null) throw wanted.error;
		if (!wanted.data) return;
		const head = authority.head();
		if (head.error !== null) throw head.error;
		const replaced = authority.replaceSnapshot(
			head.data,
			syncEngineOf(store).encodeSnapshot(),
		);
		if (replaced.error !== null) throw replaced.error;
	};
	const transaction = async (run: () => void) => {
		run();
		sinceSend += 1;
		if (sinceSend < SEND_EVERY) return;
		sinceSend = 0;
		await send();
	};
	/** One row's content node, live on the one document (ADR-0295). */
	const bodyOf = (id: string) => {
		const content = db.tables.notes.get(id)?.content;
		if (content === undefined) throw new Error('the row has no content');
		return content;
	};

	const alive: string[] = [];
	let canaryId = '';
	for (let index = 0; index < NOTES; index += 1) {
		// The canary is a note the workload below never touches, so what the
		// arriving replica must hold is known exactly rather than reconstructed.
		const canary = index === NOTES - 1;
		const made = db.tables.notes.create({
			title: canary ? 'the canary note' : `note ${index}`,
		});
		const text = bodyOf(made.id);
		await transaction(() => {
			text.applyDelta(
				text.change.insert(
					canary ? `${CANARY_MARKER}${bodyText(index)}` : bodyText(index),
				) as never,
			);
		});
		if (canary) canaryId = made.id;
		else alive.push(made.id);
	}

	let created = NOTES;
	for (let day = 0; day < days; day += 1) {
		for (let edit = 0; edit < DAY.fieldEdits; edit += 1) {
			const id = alive[(day * 7 + edit) % alive.length] as string;
			await transaction(() => {
				const edited = db.tables.notes.update(id, {
					title: `edited on day ${day}`,
				});
				if (edited.error !== null) throw edited.error;
			});
		}
		for (let keystroke = 0; keystroke < DAY.charsTyped; keystroke += 1) {
			const id = alive[(day * 3 + keystroke) % alive.length] as string;
			const text = bodyOf(id);
			await transaction(() => {
				text.applyDelta(text.change.retain(10).insert('a') as never);
			});
		}
		for (let gone = 0; gone < DAY.notesDeleted; gone += 1) {
			const victim = alive.shift() as string;
			await transaction(() => {
				db.tables.notes.delete(victim);
			});
		}
		for (let fresh = 0; fresh < DAY.notesCreated; fresh += 1) {
			const index = created;
			created += 1;
			const made = db.tables.notes.create({ title: `note ${index}` });
			const text = bodyOf(made.id);
			await transaction(() => {
				text.applyDelta(text.change.insert(bodyText(index)) as never);
				alive.push(made.id);
			});
		}
	}
	await send();

	// What the hub puts on the wire for a connection at cursor zero: the snapshot
	// first if there is one, then every entry after the position it covers. This
	// mirrors `deliver` in `sync/hub.ts` rather than restating a policy.
	const snapshot = authority.snapshot();
	if (snapshot.error !== null) throw snapshot.error;
	const from = snapshot.data?.position ?? 0;
	const tail = authority.since(from, Number.MAX_SAFE_INTEGER);
	if (tail.error !== null) throw tail.error;
	const stored = authority.storedBytes();
	if (stored.error !== null) throw stored.error;
	const head = authority.head();
	if (head.error !== null) throw head.error;

	const payload = [
		...(snapshot.data === undefined ? [] : [snapshot.data.bytes]),
		...tail.data.map((entry) => entry.bytes),
	];
	const snapshotBytes = snapshot.data?.bytes.length ?? 0;
	let tailBytes = 0;
	for (const entry of tail.data) tailBytes += entry.bytes.length;

	const ids = db.tables.notes.ids();
	const canary = db.tables.notes.get(canaryId);
	if (canary === undefined) throw new Error('the canary row is gone');
	const canaryText = bodyOf(canaryId).toString();

	return {
		payload,
		report: {
			days,
			mode,
			transferBytes: snapshotBytes + tailBytes,
			entries: payload.length,
			snapshotBytes,
			tailBytes,
			tailEntries: tail.data.length,
			storedBytes: stored.data,
			head: head.data,
			snapshotPosition: snapshot.data?.position ?? 0,
			liveRows: ids.length,
			canaryTitle: canary.title ?? '',
			canaryText,
		},
	};
}

// ---------------------------------------------------------------------------
// Apply: an empty replica takes the payload, and has to end up with the vault.
// ---------------------------------------------------------------------------

/** `[u32 length][bytes]` repeated, which is all the payload file has to be. */
function packPayload(updates: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const update of updates) total += update.length + 4;
	const packed = new Uint8Array(total);
	const view = new DataView(packed.buffer);
	let at = 0;
	for (const update of updates) {
		view.setUint32(at, update.length, true);
		packed.set(update, at + 4);
		at += update.length + 4;
	}
	return packed;
}

function unpackPayload(packed: Uint8Array): Uint8Array[] {
	const view = new DataView(
		packed.buffer,
		packed.byteOffset,
		packed.byteLength,
	);
	const updates: Uint8Array[] = [];
	let at = 0;
	while (at < packed.length) {
		const length = view.getUint32(at, true);
		updates.push(packed.subarray(at + 4, at + 4 + length));
		at += length + 4;
	}
	return updates;
}

type Expectation = {
	liveRows: number;
	canaryTitle: string;
	canaryText: string;
};

async function apply(
	packed: Uint8Array,
	expectation: Expectation,
): Promise<ApplyReport> {
	const updates = unpackPayload(packed);
	const db = await openAccountStore({
		definition: benchDatabase,
		sqlite: createBunSqliteAdapter(new Database(':memory:')),
	});
	const store = db;

	let appliedBytes = 0;
	const started = performance.now();
	for (const update of updates) {
		// `applyRemote` commits what it received, which is what a real replica does
		// and is part of what the arriving device actually waits on.
		const applied = syncEngineOf(store).applyRemote(new Uint8Array(update));
		if (applied.error !== null) throw applied.error;
		appliedBytes += update.length;
	}
	await store.persistence.flush();
	const applyMs = performance.now() - started;

	// The control. Bytes moving is not the claim; the vault arriving is.
	const rows = db.tables.notes;
	const canary = rows.rows.find((row) => row.title === expectation.canaryTitle);
	let text: string | undefined;
	if (canary !== undefined) {
		text = db.tables.notes.get(canary.id)?.content.toString();
	}
	// Guarding the guard: an expectation of an empty string would be satisfied by
	// a replica that received nothing, which is the exact run this control exists
	// to catch.
	const expectationIsReal =
		expectation.canaryText.includes(CANARY_MARKER) &&
		expectation.canaryText.length > BODY_CHARS;
	const verified =
		expectationIsReal &&
		rows.rows.length === expectation.liveRows &&
		rows.nonconforming.length === 0 &&
		canary !== undefined &&
		text === expectation.canaryText &&
		!syncEngineOf(store).hasUnresolvedDependencies();

	return {
		applyMs,
		appliedBytes,
		appliedEntries: updates.length,
		verified,
		saw: `${rows.rows.length} rows and ${rows.nonconforming.length} nonconforming, canary ${
			canary === undefined ? 'MISSING' : 'present'
		}, text ${text === undefined ? 'MISSING' : `${text.length} chars`}, unresolved dependencies ${syncEngineOf(store).hasUnresolvedDependencies()}`,
	};
}

// ---------------------------------------------------------------------------
// Child entry points. Each measured case gets its own process.
// ---------------------------------------------------------------------------

if (process.argv[2] === '--build') {
	const days = Number(process.argv[3]);
	const mode = process.argv[4] as Mode;
	const path = process.argv[5] as string;
	const started = performance.now();
	const { report, payload } = await build(days, mode);
	const buildMs = performance.now() - started;
	await Bun.write(path, packPayload(payload));
	console.log(JSON.stringify({ ...report, buildMs } satisfies BuildReport));
	process.exit(0);
}

if (process.argv[2] === '--apply') {
	const path = process.argv[3] as string;
	const expectation = JSON.parse(process.argv[4] as string) as Expectation;
	const packed = new Uint8Array(await Bun.file(path).arrayBuffer());
	console.log(
		JSON.stringify((await apply(packed, expectation)) satisfies ApplyReport),
	);
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent: drive the cases, print the table, print the controls.
// ---------------------------------------------------------------------------

function child<TReport>(args: string[]): TReport {
	const proc = Bun.spawnSync([process.execPath, import.meta.path, ...args]);
	const out = proc.stdout.toString().trim();
	if (out === '') {
		throw new Error(
			`a measuring process produced nothing: ${proc.stderr.toString().trim()}`,
		);
	}
	return JSON.parse(out.split('\n').at(-1) as string) as TReport;
}

const mb = (bytes: number) =>
	bytes >= 1048576
		? `${(bytes / 1048576).toFixed(1)} MB`
		: `${Math.round(bytes / 1024)} KB`;

const directory = await mkdtemp(join(tmpdir(), 'epicenter-first-sync-'));
try {
	console.log(
		`runtime  bun ${Bun.version} (${process.platform}/${process.arch})`,
	);
	console.log(
		`corpus   ${NOTES} notes with ${BODY_CHARS / 1000} KB body text, then N days of use`,
	);
	console.log(
		`a day    ${DAY.charsTyped} characters typed, ${DAY.fieldEdits} field edits, ${DAY.notesDeleted} notes deleted, ${DAY.notesCreated} created`,
	);
	console.log(
		`sending  one entry per ${SEND_EVERY} transactions, which is the client's idle-timer merge\n`,
	);

	const rows: { build: BuildReport; applied: ApplyReport }[] = [];
	for (const days of DAY_SAMPLES) {
		for (const mode of ['snapshot', 'log'] as const) {
			const path = join(directory, `${mode}-${days}.bin`);
			const built = child<BuildReport>(['--build', String(days), mode, path]);
			const applied = child<ApplyReport>([
				'--apply',
				path,
				JSON.stringify({
					liveRows: built.liveRows,
					canaryTitle: built.canaryTitle,
					canaryText: built.canaryText,
				} satisfies Expectation),
			]);
			rows.push({ build: built, applied });
		}
	}

	console.log('WHAT A BRAND-NEW REPLICA DOWNLOADS AND APPLIES');
	console.log(
		`  ${'history'.padStart(8)} ${'design'.padEnd(16)} ${'transfer'.padStart(9)} ${'entries'.padStart(8)} ${'apply'.padStart(9)} ${'live rows'.padStart(10)} ${'control'.padStart(8)}`,
	);
	for (const { build: built, applied } of rows) {
		console.log(
			`  ${`${built.days} days`.padStart(8)} ${(built.mode === 'snapshot' ? 'snapshot+tail' : 'append-only log').padEnd(16)} ${mb(built.transferBytes).padStart(9)} ${built.entries.toLocaleString().padStart(8)} ${`${applied.applyMs.toFixed(0)} ms`.padStart(9)} ${built.liveRows.toLocaleString().padStart(10)} ${(applied.verified ? 'held' : 'FAILED').padStart(8)}`,
		);
	}

	console.log('\nWHY THE TAIL IS NOT SHORT');
	console.log(
		'  "at" is the position the live snapshot covers and "head" is where the log has reached, so the',
	);
	console.log(
		'  gap between them is history piled up since the last replacement. "retained" is every snapshot',
	);
	console.log(
		'  row the authority is holding, which is TWO positions by design so a bad snapshot has a way',
	);
	console.log(
		'  back. `shouldSnapshot` compares the tail against that sum rather than against the live',
	);
	console.log(
		'  snapshot alone, so the tail is allowed to reach roughly twice the state before anything fires.',
	);
	console.log(
		`  ${'history'.padStart(8)} ${'snapshot'.padStart(9)} ${'retained'.padStart(9)} ${'at'.padStart(7)} ${'head'.padStart(7)} ${'tail'.padStart(9)} ${'tail entries'.padStart(13)} ${'tail vs snapshot'.padStart(17)}`,
	);
	for (const { build: built } of rows) {
		if (built.mode !== 'snapshot') continue;
		console.log(
			`  ${`${built.days} days`.padStart(8)} ${mb(built.snapshotBytes).padStart(9)} ${mb(built.storedBytes - built.tailBytes).padStart(9)} ${built.snapshotPosition.toLocaleString().padStart(7)} ${built.head.toLocaleString().padStart(7)} ${mb(built.tailBytes).padStart(9)} ${built.tailEntries.toLocaleString().padStart(13)} ${`${Math.round((built.tailBytes / Math.max(built.snapshotBytes, 1)) * 100)}%`.padStart(17)}`,
		);
	}

	console.log('\nWHERE THE TIME GOES');
	console.log(
		'  Applying is per entry, not per byte: every entry is one commit on the arriving device. Two',
	);
	console.log(
		'  rows with the same transfer size and different entry counts do not cost the same.',
	);
	console.log(
		`  ${'history'.padStart(8)} ${'design'.padEnd(16)} ${'entries'.padStart(8)} ${'per entry'.padStart(10)} ${'throughput'.padStart(11)}`,
	);
	for (const { build: built, applied } of rows) {
		console.log(
			`  ${`${built.days} days`.padStart(8)} ${(built.mode === 'snapshot' ? 'snapshot+tail' : 'append-only log').padEnd(16)} ${built.entries.toLocaleString().padStart(8)} ${`${(applied.applyMs / Math.max(built.entries, 1)).toFixed(2)} ms`.padStart(10)} ${`${(applied.appliedBytes / 1048576 / (applied.applyMs / 1000)).toFixed(1)} MB/s`.padStart(11)}`,
		);
	}

	const snapshots = rows.filter((row) => row.build.mode === 'snapshot');
	const logs = rows.filter((row) => row.build.mode === 'log');
	const first = { snapshot: snapshots[0], log: logs[0] };
	const last = { snapshot: snapshots.at(-1), log: logs.at(-1) };

	console.log('\nHOW EACH COLUMN MOVES AS HISTORY GROWS');
	const growth = (from: number, to: number) =>
		`${(to / Math.max(from, 1)).toFixed(1)}x`;
	if (
		first.snapshot !== undefined &&
		last.snapshot !== undefined &&
		first.log !== undefined &&
		last.log !== undefined
	) {
		console.log(
			`  snapshot+tail    ${mb(first.snapshot.build.transferBytes)} to ${mb(last.snapshot.build.transferBytes)} (${growth(first.snapshot.build.transferBytes, last.snapshot.build.transferBytes)} bytes), ${first.snapshot.applied.applyMs.toFixed(0)} ms to ${last.snapshot.applied.applyMs.toFixed(0)} ms (${growth(first.snapshot.applied.applyMs, last.snapshot.applied.applyMs)} time)`,
		);
		console.log(
			`  append-only log  ${mb(first.log.build.transferBytes)} to ${mb(last.log.build.transferBytes)} (${growth(first.log.build.transferBytes, last.log.build.transferBytes)} bytes), ${first.log.applied.applyMs.toFixed(0)} ms to ${last.log.applied.applyMs.toFixed(0)} ms (${growth(first.log.applied.applyMs, last.log.applied.applyMs)} time)`,
		);
	}

	console.log('\nCONTROLS');
	const report = (held: boolean, label: string) =>
		console.log(`  ${held ? 'held  ' : 'FAILED'}  ${label}`);
	report(
		rows.every((row) => row.applied.verified),
		"every arrival ended up with the vault: the right live row count, the canary note's title, and its whole body text read back out of its content node and compared to the resident replica's",
	);
	report(
		rows.every((row) => row.applied.appliedEntries === row.build.entries),
		'every arrival applied exactly the entries it was handed',
	);
	// Without this the whole table could be measuring a workload too small to
	// separate the designs, which is the way a bench like this quietly stops
	// being able to fail.
	if (first.log !== undefined && last.log !== undefined) {
		report(
			last.log.build.transferBytes > first.log.build.transferBytes * 2,
			`the append-only control climbs with history (${mb(first.log.build.transferBytes)} to ${mb(last.log.build.transferBytes)})`,
		);
	}
	if (last.snapshot !== undefined && last.log !== undefined) {
		report(
			last.snapshot.build.transferBytes < last.log.build.transferBytes,
			`snapshot+tail transfers less than the log at the longest history (${mb(last.snapshot.build.transferBytes)} against ${mb(last.log.build.transferBytes)})`,
		);
	}
	// Without this, a bug that ignored `mode` would print two identical columns
	// and every other control above would still say held.
	report(
		snapshots.some((row, index) => {
			const control = logs[index];
			return control !== undefined && row.build.entries < control.build.entries;
		}),
		'the two designs really are two designs: at least one history has strictly fewer entries under snapshot+tail',
	);

	// The negative control: an arrival handed nothing must FAIL the verification
	// every row above passed. Without it, "held" on that line means only that the
	// check ran, not that it can distinguish a converged replica from an empty one.
	const emptyPath = join(directory, 'empty.bin');
	await Bun.write(emptyPath, new Uint8Array(0));
	const emptyExpectation = rows[0]?.build;
	if (emptyExpectation !== undefined) {
		const nothing = child<ApplyReport>([
			'--apply',
			emptyPath,
			JSON.stringify({
				liveRows: emptyExpectation.liveRows,
				canaryTitle: emptyExpectation.canaryTitle,
				canaryText: emptyExpectation.canaryText,
			} satisfies Expectation),
		]);
		report(
			!nothing.verified,
			`an arrival given an empty payload FAILS the same check (saw ${nothing.saw})`,
		);
	}

	console.log('\nNOT MEASURED');
	console.log('  memory on the arriving device (see evidence/bench/memory.ts)');
	console.log(
		'  network time: transfer bytes are reported, transfer seconds are not',
	);
	console.log(
		'  hydration of an already-populated replica from its own SQLite file',
	);
	console.log(
		'  a second writer: one device authored this whole history, so no concurrent merge is priced',
	);
	let buildMs = 0;
	for (const { build: built } of rows) buildMs += built.buildMs;
	console.log(
		`\nreplaying the histories cost ${(buildMs / 1000).toFixed(0)} s across ${rows.length} build processes, which is not a measurement of anything.`,
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
