import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { defineStore, defineTable, field, plainText } from '@epicenter/app';
import { InstantString } from '@epicenter/app/definition';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { createMemoryRecord, openMemory } from './memory.js';
import {
	type Data,
	type DataDocument,
	openAccountStore,
	syncEngineOf,
} from './store.js';

const database = defineStore({
	id: 'so.epicenter.honeycrisp',
	kv: { theme: field.select(['light', 'dark']), fontSize: field.number() },
	tables: {
		notes: defineTable({
			fields: {
				title: field.string(),
				tags: field.tags(),
				date: field.nullable(field.string()),
			},
			body: plainText(),
		}),
	},
});

let db: Data<typeof database>;

beforeEach(async () => {
	db = await openMemory(database);
});

/** A note, and its minted id, for tests that need one to exist. */
function note(
	fields: Partial<Parameters<typeof db.tables.notes.create>[0]> = {},
) {
	return db.tables.notes.create({
		title: 'Groceries',
		tags: ['food'],
		date: null,
		...fields,
	});
}

/** One row's body type, which `store.watch` takes directly. */
function editorOf(id: string) {
	const body = db.tables.notes.body(id);
	if (body === undefined) throw new Error('the row has no body');
	return body;
}

/** Wrap one application-document update the way the wire carries it. */

function exchange(a: DataDocument, b: DataDocument) {
	const fromA = a.encodeStateSince(b.stateVector());
	const fromB = b.encodeStateSince(a.stateVector());
	syncEngineOf(b).applyRemote(fromA);
	syncEngineOf(a).applyRemote(fromB);
}

describe('a read is a property access on a plain object', () => {
	test('disposing the data disposes the store under it', async () => {
		// This asserted `data.store !== data`, which nearly any implementation
		// satisfies including a broken one. What the sentence actually claims is
		// ownership, and ownership is only observable at disposal.
		const opened = await openMemory(database);
		{
			await using data = opened;
			expect(data.tables.notes.rows).toEqual([]);
		}
		expect(() => opened.tables.notes.rows).toThrow();
	});

	test('create returns the row it made, at a minted id', async () => {
		const made = note();
		expect(made.id).toBeString();
		expect(made.id).toHaveLength(24);
		expect(made.title).toBe('Groceries');
		expect(made.tags).toEqual(['food']);
	});

	test('an absent row reads as undefined, which is a fact not a failure', async () => {
		expect(db.tables.notes.get('nope')).toBeUndefined();
	});

	test('every value verb is synchronous; only a document open is a load', async () => {
		// One in-memory application document over a synchronous SQLite boundary,
		// so no value read or write has I/O to await. The one asynchronous verb
		// is the data opener, which is a load by decision (ADR-0248).
		const made = note();
		for (const value of [
			db.tables.notes.get(made.id),
			db.tables.notes.update(made.id, { title: 'x' }),
			db.tables.notes.rows,
			db.tables.notes.ids(),
			db.kv.get('theme'),
			db.kv.update({ theme: 'dark' }),
			db.tables.notes.delete(made.id),
		]) {
			expect(value).not.toBeInstanceOf(Promise);
		}
	});

	test('data groups direct operations with transact', async () => {
		let notifications = 0;
		db.tables.notes.subscribe(() => {
			notifications += 1;
		});

		db.transact(() => {
			note({ title: 'one' });
			note({ title: 'two' });
		});

		// One notification for two rows, which is the point of grouping: a
		// transaction is one commit, so it is one thing to re-read after.
		expect(notifications).toBe(1);
		expect(db.tables.notes.rows).toHaveLength(2);
	});
});

describe('a write that reaches nothing is a failure', () => {
	test('update on an absent row refuses instead of swallowing it', async () => {
		const { data, error } = db.tables.notes.update('nope', { title: 'x' });
		expect(data).toBeNull();
		// The verb this replaces returned Ok(undefined) and dropped the write.
		expect(error?.name).toBe('RowAbsent');
	});

	test('create admits a payload and get reports its conformance', async () => {
		const made = db.tables.notes.create({} as never);
		expect(made.id).toHaveLength(24);
		// A row this declaration cannot read does not arrive through `get`; it is
		// on `nonconforming`, with its raw values and the fields that failed.
		expect(db.tables.notes.get(made.id)).toBeUndefined();
		const issue = db.tables.notes.nonconforming.find(
			(candidate) => candidate.id === made.id,
		);
		expect(issue?.issues.map((each) => each.field)).toEqual([
			'title',
			'tags',
			'date',
		]);
	});

	test('an invalid supplied value is written and reported on read', async () => {
		const made = note();
		const result = db.tables.notes.update(made.id, {
			tags: 'food' as never,
		});
		expect(result.error).toBeNull();
		// The write lands; the read is where the declaration objects. `get` stops
		// answering for the row, and `nonconforming` carries what survived so a
		// caller can compose its own repair (ADR-0125).
		expect(db.tables.notes.get(made.id)).toBeUndefined();
		const reported = db.tables.notes.nonconforming.find(
			(candidate) => candidate.id === made.id,
		);
		expect(reported?.conforming.title).toBe('Groceries');
		expect(reported?.issues.map((issue) => issue.field)).toEqual(['tags']);
	});

	test('row identity remains a structural boundary', async () => {
		const made = note();
		expect(() =>
			db.tables.notes.update(made.id, { id: 'forged' } as never),
		).toThrow(/reserved/);
		expect(db.tables.notes.get(made.id)?.title).toBe('Groceries');
	});
});

describe('deletion', () => {
	test('a deleted row reads as absent', async () => {
		const made = note();
		db.tables.notes.delete(made.id);
		expect(db.tables.notes.get(made.id)).toBeUndefined();
		expect(db.tables.notes.ids()).toEqual([]);
	});

	test('deleting twice leaves the table exactly as the first delete did', async () => {
		const made = note();
		db.tables.notes.delete(made.id);
		// Deleting an absent address reports nothing and changes nothing: the
		// verb has no outcome to report, so the second call is indistinguishable
		// from never having made it.
		db.tables.notes.delete(made.id);
		expect(db.tables.notes.get(made.id)).toBeUndefined();
		expect(db.tables.notes.ids()).toEqual([]);
	});

	test('CHURN DOES NOT ACCUMULATE A CORPSE PER DELETED ROW', async () => {
		// The reason deletion removes the row's attribute instead of clearing it
		// and flagging it absent, which is what ADR-0212 chose. A tombstone is
		// paid by every device, in memory, on every load, forever, and a phone
		// does not get to opt out. At this row's shape the two models measure 37 B
		// and 86 B per dead row, so a regression to clear-and-flag fails here long
		// before anyone notices it on a device.
		const empty = db.encodeStateSince().length;
		for (let index = 0; index < 200; index += 1) {
			db.tables.notes.delete(note({ title: 'x'.repeat(100) }).id);
		}
		expect(db.tables.notes.ids()).toEqual([]);
		const perDeadRow = (db.encodeStateSince().length - empty) / 200;
		expect(perDeadRow).toBeLessThan(60);
	});

	test('a deleted address cannot be revived, only refused', async () => {
		// Deletion takes the row's attribute off the table root, so a deleted id
		// is indistinguishable from one nothing ever held. There is no reuse path
		// to get wrong: `update` refuses, and `create` mints an id of its own.
		const made = note();
		db.tables.notes.delete(made.id);
		const { data, error } = db.tables.notes.update(made.id, { title: 'back?' });
		expect(data).toBeNull();
		expect(error?.name).toBe('RowAbsent');
		expect(db.tables.notes.get(made.id)).toBeUndefined();
	});
});

describe('a nonconforming row is reported, never repaired', () => {
	const wrongDatabase = defineStore({
		id: 'so.epicenter.honeycrisp',
		kv: {},
		tables: {
			notes: defineTable({
				fields: {
					title: field.string(),
					tags: field.string(),
					date: field.nullable(field.string()),
				},
				body: plainText(),
			}),
		},
	});

	/**
	 * Corrupt a stored value the way it actually happens: a peer device on a
	 * release whose declaration disagrees syncs the row in, writes a value its
	 * own declaration accepts, and syncs it back (ADR-0240: two definitions
	 * are never live in one runtime, but two devices may run two releases).
	 */
	async function corruptTags(rowId: string): Promise<void> {
		const peer = await openMemory(wrongDatabase);
		exchange(db, peer);
		const written = peer.tables.notes.update(rowId, { tags: 'food' });
		if (written.error !== null) throw written.error;
		exchange(db, peer);
	}

	test('the call site composes application recovery and what survived', async () => {
		const made = note();
		await corruptTags(made.id);

		const row = db.tables.notes.get(made.id);
		expect(row).toBeUndefined();
		// Plain diagnostic data, not a tagged error: nonconformance is a fact
		// about the table, so it is reported on the table rather than handed back
		// as one row's failure.
		const reported = db.tables.notes.nonconforming.find(
			(candidate) => candidate.id === made.id,
		);
		expect(reported?.issues.map((issue) => issue.field)).toEqual(['tags']);
		// Never repaired and never hidden: the raw payload survives intact.
		expect(reported?.raw).toEqual({
			title: 'Groceries',
			tags: 'food',
			date: null,
		});

		// The one recovery composition, and it still reads as one expression.
		const recovered = row ?? { id: made.id, ...reported?.conforming };
		expect(recovered).toEqual({ id: made.id, title: 'Groceries', date: null });
	});

	test('rows and nonconforming separate what it can read from what it cannot', async () => {
		const broken = note({ title: 'broken' });
		const fine = note({ title: 'fine' });
		await corruptTags(broken.id);
		const listed = db.tables.notes;
		expect(listed.rows.map((row) => row.id)).toEqual([fine.id]);
		expect(listed.nonconforming.map((issue) => issue.id)).toEqual([broken.id]);
	});
});

describe('two replicas converge', () => {
	async function pair() {
		return { laptop: await openMemory(database) };
	}

	test('a row made on one device appears on the other', async () => {
		const { laptop } = await pair();
		const made = note({ title: 'Recorded on the phone', tags: ['voice'] });
		exchange(db, laptop);

		expect(laptop.tables.notes.get(made.id)?.title).toBe(
			'Recorded on the phone',
		);
	});

	test('offline edits to different fields of one row both survive', async () => {
		const { laptop } = await pair();
		const made = note({ title: 'first' });
		exchange(db, laptop);

		db.tables.notes.update(made.id, { title: 'phone title' });
		laptop.tables.notes.update(made.id, { date: '2026-08-07' });
		exchange(db, laptop);

		for (const [name, handle] of [
			['phone', db.tables.notes],
			['laptop', laptop.tables.notes],
		] as const) {
			const settled = handle.get(made.id);
			expect(`${name}:${settled?.title}`).toBe(`${name}:phone title`);
			expect(`${name}:${settled?.date}`).toBe(`${name}:2026-08-07`);
		}
	});

	test('a delete on one device beats an edit on the other', async () => {
		// The case ADR-0212 kept a corpse per deleted row to serve. It converges
		// without one, and to the same answer: the row is gone on both devices,
		// and the offline edit is gone with it rather than lingering as a field on
		// a tombstone that a revived address would hand back
		// (`evidence/deletion-model.test.ts`).
		const { laptop } = await pair();
		const made = note({ title: 'first' });
		exchange(db, laptop);

		db.tables.notes.delete(made.id);
		laptop.tables.notes.update(made.id, { title: 'edited offline' });
		exchange(db, laptop);

		expect(db.tables.notes.get(made.id)).toBeUndefined();
		expect(laptop.tables.notes.get(made.id)).toBeUndefined();
		expect(laptop.tables.notes.ids()).toEqual([]);
	});

	test('two devices creating rows concurrently keep both', async () => {
		// Safe by construction rather than by care: a minted 24-character id
		// cannot collide, so two devices never mint a container at one address.
		const { laptop } = await pair();
		note({ title: 'from the phone' });
		laptop.tables.notes.create({
			title: 'from the laptop',
			tags: [],
			date: null,
		});
		exchange(db, laptop);

		expect(db.tables.notes.rows).toHaveLength(2);
		expect(laptop.tables.notes.rows).toHaveLength(2);
	});
});

describe("a row's body node lives on the row (ADR-0295)", () => {
	test('an absent row has no body, which is a fact not a failure', () => {
		expect(db.tables.notes.get('nope')).toBeUndefined();
	});

	test('a body node is minted with its row and is empty', () => {
		const made = note();
		const body = db.tables.notes.body(made.id);
		expect(body).toBeDefined();
		expect(body?.length).toBe(0);
	});

	test('deleting the row takes its body node with it', () => {
		const made = note();
		const body = db.tables.notes.body(made.id);
		body?.applyDelta(body.change.insert('milk') as never);
		db.tables.notes.delete(made.id);
		expect(db.tables.notes.get(made.id)).toBeUndefined();
	});

	test('body is a live node on the row, never a JSON value', () => {
		// `get` carries it and `stored()` cannot: the faithful read answers in
		// JSON, and a nested type is not one. That is the whole reason the
		// exporter reads through `store.rowFile` rather than through `stored`.
		const made = note();
		const stored = db.stored().tables.get('notes')?.get(made.id);
		expect(Object.keys(stored ?? {})).not.toContain('body');
		expect(db.tables.notes.body(made.id)).toBeDefined();
	});

	test('body written into its own node cannot touch the row', () => {
		// Bound to the ROW itself, a ProseMirror schema whose doc node declares
		// attributes would overwrite the row's fields and sync that; measured in
		// ADR-0215. The body node is nested UNDER the row, so its
		// attributes are its own.
		const made = note();
		db.tables.notes
			.body(made.id)
			?.setAttr('title' as never, 'CLOBBER' as never);
		expect(db.tables.notes.get(made.id)?.title).toBe('Groceries');
	});

	test('the body node rides the whole state and comes back attached', async () => {
		const made = note();
		const body = db.tables.notes.body(made.id);
		body?.applyDelta(body.change.insert('milk and eggs') as never);

		const laptop = await openMemory(database);
		syncEngineOf(laptop).applyRemote(db.encodeStateSince());
		expect(laptop.tables.notes.body(made.id)?.toString()).toContain(
			'milk and eggs',
		);
	});
});

describe('kv is where anything two devices both write belongs', () => {
	test('an unwritten key reads as undefined and is reported', async () => {
		// The application falls back; the platform says which keys it could not
		// read. Never defaulted here, because a default in a definition would be
		// a value nothing stored (ADR-0255).
		expect(db.kv.get('theme')).toBeUndefined();
		expect(db.kv.nonconforming.map(({ field }) => field)).toEqual([
			'theme',
			'fontSize',
		]);
	});

	test('a write touches only the keys it names', async () => {
		db.kv.update({ theme: 'dark' });
		expect(db.kv.get('theme')).toBe('dark');
		expect(db.kv.get('fontSize')).toBeUndefined();
	});

	test('an undeclared key is preserved for a future declaration', async () => {
		db.kv.update({ nope: 1 } as never);
		expect(db.stored().kv).toEqual({ nope: 1 });
		expect(db.kv.get('theme')).toBeUndefined();
	});

	test('ONE unreadable key costs that key and not the object', async () => {
		// The whole reason conformance is per key. It used to be whole-object:
		// one bad value made every read an error, and both applications rebuilt
		// the good half by hand out of the diagnostic.
		db.kv.update({ fontSize: 20 });
		db.kv.update({ theme: 'purple' as never });
		expect(db.kv.get('fontSize')).toBe(20);
		expect(db.kv.get('theme')).toBeUndefined();
		expect(db.kv.nonconforming.map(({ field }) => field)).toEqual(['theme']);
	});

	test('TWO DEVICES BOOTING OFFLINE BOTH KEEP THEIR SETTINGS', async () => {
		// The case that motivated moving KV to a reserved root. Through a chosen
		// row id this loses one device's write entirely, because each mints its
		// own nested container and map LWW keeps one. A root is addressed by its
		// name, so both survive. `evidence/bench/row-model.ts` keeps the losing
		// contrast, now that the chosen-id door is gone from the API.
		const phone = await openMemory(database);
		const laptop = await openMemory(database);

		phone.kv.update({ theme: 'dark' });
		laptop.kv.update({ fontSize: 22 });
		exchange(phone, laptop);

		// Both writes survive on both devices, which is the claim.
		for (const device of [phone, laptop]) {
			expect(device.kv.get('theme')).toBe('dark');
			expect(device.kv.get('fontSize')).toBe(22);
		}
	});
});

describe('a received update is persisted as the bytes that arrived', () => {
	test('an update whose dependencies are missing survives a RESTART', async () => {
		// Yjs buffers an update it cannot integrate, applyUpdateV2 returns
		// normally, and the document emits NO updateV2 event. Persisting emitted
		// bytes writes nothing, so the bytes are lost at restart while every
		// layer reported success. The restart is the whole test: an in-memory
		// store keeps the buffered update either way.
		const origin = await openMemory(database);
		const made = origin.tables.notes.create({
			title: 'first',
			tags: [],
			date: null,
		});
		const first = origin.encodeStateSince();
		const afterFirst = origin.stateVector();
		origin.tables.notes.update(made.id, { title: 'second' });
		const second = origin.encodeStateSince(afterFirst);

		// A close and a reopen over one durable record: the pending bytes were
		// stored as they arrived, so the gap is still a gap on the way back up.
		const record = createMemoryRecord();
		const laptop = await openMemory(database, record);
		expect(syncEngineOf(laptop).applyRemote(second).error).toBeNull();
		expect(syncEngineOf(laptop).hasUnresolvedDependencies()).toBe(true);
		await laptop[Symbol.asyncDispose]();

		const db2 = await openMemory(database, record);
		const reopened = syncEngineOf(db2);
		expect(reopened.hasUnresolvedDependencies()).toBe(true);

		expect(reopened.applyRemote(first).error).toBeNull();
		expect(reopened.hasUnresolvedDependencies()).toBe(false);
		expect(db2.tables.notes.get(made.id)?.title).toBe('second');
		await db2[Symbol.asyncDispose]();
	});

	test('a fully applied replica reports no unresolved dependencies', async () => {
		note();
		const laptop = await openMemory(database);
		syncEngineOf(laptop).applyRemote(db.encodeStateSince(laptop.stateVector()));
		expect(syncEngineOf(laptop).hasUnresolvedDependencies()).toBe(false);
	});
});

describe('pressure is the number that decides whether any of this matters', () => {
	test('a healthy document sits near the item cost of one row', async () => {
		for (let index = 0; index < 20; index += 1)
			note({ title: `note ${index}` });
		const pressure = db.pressure();

		expect(pressure.liveRows).toBe(20);
		// A note here is a container and three fields, so
		// single digits. The absolute number is not the point; the ratio is.
		expect(pressure.itemsPerLiveRow).toBeLessThan(15);
	});

	test('churn drives it up, which is the whole signal', async () => {
		// Twenty live rows either way. The only difference is how many died to get
		// there, and that is exactly what the ratio has to expose, because the two
		// documents are indistinguishable from every other verb.
		for (let index = 0; index < 20; index += 1)
			note({ title: `keeper ${index}` });
		const healthy = db.pressure().itemsPerLiveRow;

		for (let index = 0; index < 200; index += 1) {
			const doomed = note({ title: `churn ${index}` });
			db.tables.notes.delete(doomed.id);
		}
		const churned = db.pressure();

		expect(churned.liveRows).toBe(20);
		expect(churned.itemsPerLiveRow).toBeGreaterThan(healthy * 3);
	});

	test('an empty document reports its items rather than dividing by zero', async () => {
		const pressure = db.pressure();

		expect(pressure.liveRows).toBe(0);
		expect(Number.isFinite(pressure.itemsPerLiveRow)).toBe(true);
	});
});

describe('a subscription says a table changed', () => {
	/** Every invalidation one table handed a listener, in order. */
	/**
	 * Counts notifications rather than collecting payloads.
	 *
	 * What these assert is how MANY times a table said something and for which
	 * table. The ids it hands over are pinned separately, below, so a change to
	 * the payload cannot quietly pass by breaking only the counting.
	 */
	function record(table: { subscribe(listener: () => void): () => void }) {
		const seen: 'changed'[] = [];
		const stop = table.subscribe(() => seen.push('changed'));
		return { seen, stop };
	}

	test('registration is synchronous and never fires initially', async () => {
		// ADR-0187's law 2. A caller that subscribes and then reads has already
		// seen everything, so an initial delivery would only ever be a duplicate
		// that every consumer has to learn to ignore.
		note();
		const { seen } = record(db.tables.notes);

		expect(seen).toEqual([]);
	});

	test('a created row, an edited row and a deleted row each name themselves', async () => {
		const { seen } = record(db.tables.notes);

		const made = note();
		expect(seen).toEqual(['changed']);

		db.tables.notes.update(made.id, { title: 'Shopping' });
		expect(seen.at(-1)).toBe('changed');

		db.tables.notes.delete(made.id);
		expect(seen.at(-1)).toBe('changed');
		expect(seen).toHaveLength(3);
	});

	test('the ids name the rows a commit touched, on every arm', async () => {
		// The reason the payload exists: a caller holding a projection keyed by
		// row id rebuilds only what moved. A list may ignore this and re-read.
		const seen: string[][] = [];
		db.tables.notes.subscribe((rowIds) => seen.push([...rowIds]));

		const made = note();
		expect(seen.at(-1)).toEqual([made.id]);

		db.tables.notes.update(made.id, { title: 'Shopping' });
		expect(seen.at(-1)).toEqual([made.id]);

		db.tables.notes.delete(made.id);
		expect(seen.at(-1)).toEqual([made.id]);

		// One commit naming several rows names all of them, once.
		const a = note();
		const b = note();
		db.transact(() => {
			db.tables.notes.update(a.id, { title: 'A' });
			db.tables.notes.update(b.id, { title: 'B' });
		});
		expect(seen.at(-1)?.slice().sort()).toEqual([a.id, b.id].sort());
	});

	test('a table nobody subscribes to names nothing', async () => {
		// The delta listener is attached with the first subscriber and dropped
		// with the last, so the naming is paid for by the tables being watched.
		// Without this a commit in an application that renders no list would
		// collect ids into a set nothing ever reads.
		const first = note();
		const seen: string[][] = [];
		const stop = db.tables.notes.subscribe((rowIds) => seen.push([...rowIds]));
		stop();
		db.tables.notes.update(first.id, { title: 'after' });

		expect(seen).toEqual([]);
	});

	test("a write to another table is not this table's business", async () => {
		// The control. Without it every assertion above would still pass on an
		// implementation that invalidated every subscriber on every commit.
		const other = await openMemory(
			defineStore({
				id: 'so.epicenter.honeycrisp',
				kv: {},
				tables: {
					notes: defineTable({
						fields: {
							title: field.string(),
							tags: field.tags(),
							date: field.nullable(field.string()),
						},
						body: plainText(),
					}),
					folders: defineTable({
						fields: {
							name: field.string(),
						},
						body: plainText(),
					}),
				},
			}),
		);
		const notes = record(other.tables.notes);
		const folders = record(other.tables.folders);

		other.tables.folders.create({ name: 'Inbox' });

		expect(folders.seen).toEqual(['changed']);
		expect(notes.seen).toEqual([]);
	});

	test('one commit touching many rows is ONE call carrying every id', async () => {
		// ADR-0187's law 3. A remote update is the only thing in this surface
		// that commits more than one row at a time, so it is what proves it.
		const author = await openMemory(database);
		const ids = [0, 1, 2].map((index) => {
			const made = author.tables.notes.create({
				title: `note ${index}`,
				tags: [],
				date: null,
			});
			return made.id;
		});
		const { seen } = record(db.tables.notes);

		syncEngineOf(db).applyRemote(author.encodeStateSince());

		// One notification for the whole remote batch, however many rows it
		// carried: a subscriber re-reads, so telling it twice would only cost it
		// a second walk of the same document.
		expect(seen).toEqual(['changed']);
		expect(db.tables.notes.rows.map((row) => row.id).sort()).toEqual(
			[...ids].sort(),
		);
	});

	test("text written into a row's body node is NOT a table commit", () => {
		// The refusal a table signal is drawn around. A row's body node is
		// nested on the row (ADR-0295), so a keystroke modifies the field and
		// nothing shallower. `deliver` reads what a transaction changed
		// DIRECTLY, and counts only the table root (a row added or removed) and
		// a row (its values), so the bubble that used to wake every list in the
		// application at typing frequency does not happen.
		//
		// What a listener that wants node edits uses instead is `watch`, which is
		// scoped to the one field.
		const made = note();
		const { seen } = record(db.tables.notes);

		const body = db.tables.notes.body(made.id);
		if (body === undefined) throw new Error('the row has no body');
		body.applyDelta(body.change.insert('milk and eggs') as never);
		expect(seen).toEqual([]);
	});

	test('editing a row value IS a table commit', () => {
		// The other side of the depth rule, and the reason it is two levels
		// rather than one: a value lives on the ROW, not on the table root, so
		// a rule that counted only the root would leave a renamed note showing
		// its old title in every list.
		const made = note();
		const { seen } = record(db.tables.notes);

		db.tables.notes.update(made.id, { title: 'renamed' });
		expect(seen).toEqual(['changed']);
	});

	test('unsubscribing stops delivery, and doing it twice is harmless', async () => {
		const { seen, stop } = record(db.tables.notes);
		note();
		expect(seen).toHaveLength(1);

		stop();
		stop();
		note();

		expect(seen).toHaveLength(1);
	});

	test('one subscriber leaving does not silence the others', async () => {
		// The reason the teardown is idempotent and counted. A Svelte effect can
		// run its own teardown more than once, and a second decrement would
		// detach the delta listener out from under the subscribers still holding
		// one, which reads as a UI that simply stops updating.
		const first = record(db.tables.notes);
		const second = record(db.tables.notes);

		first.stop();
		first.stop();
		note();

		expect(first.seen).toHaveLength(0);
		expect(second.seen).toHaveLength(1);
	});

	test('a subscriber that throws does not cost the next one its invalidation', async () => {
		db.tables.notes.subscribe(() => {
			throw new Error('this subscriber is broken');
		});
		const { seen } = record(db.tables.notes);

		note();

		expect(seen).toEqual(['changed']);
	});

	test('a subscriber may write, and its own write is a separate notification', async () => {
		const { seen } = record(db.tables.notes);
		let wrote = false;
		let written: string | undefined;
		db.tables.notes.subscribe(() => {
			if (wrote) return;
			wrote = true;
			// A subscriber re-reads to find out what moved, which is the whole
			// contract now, and writing from inside its own notification is the
			// case the swap-before-deliver buffer exists for.
			written = db.tables.notes.rows.at(0)?.id;
			if (written !== undefined) {
				db.tables.notes.update(written, { title: 'renamed' });
			}
		});

		const made = note();

		expect(written).toBe(made.id);
		expect(db.tables.notes.get(made.id)?.title).toBe('renamed');
		expect(seen).toEqual(['changed', 'changed']);
	});
});

describe('kv reports its own changes', () => {
	test('a local update notifies, and the listener reads the new value', async () => {
		const seen: unknown[] = [];
		db.kv.subscribe(() => seen.push(db.kv.get('theme')));

		db.kv.update({ theme: 'dark' });

		expect(seen).toEqual(['dark']);
	});

	test('a change that arrived from a peer notifies too', async () => {
		// The case a settings screen exists for: another device changed a
		// preference and this one has to stop showing the old value.
		const author = await openMemory(database);
		author.kv.update({ fontSize: 22 });
		const seen: unknown[] = [];
		db.kv.subscribe(() => seen.push(db.kv.get('fontSize')));

		syncEngineOf(db).applyRemote(author.encodeStateSince());

		expect(seen).toEqual([22]);
	});

	test('CONTROL: a table write does not notify kv', async () => {
		// Without this, an implementation that notified every subscriber on
		// every commit would satisfy both tests above.
		const seen: unknown[] = [];
		db.kv.subscribe(() => seen.push('kv'));

		note();

		expect(seen).toEqual([]);
	});

	test('registration never fires initially, and unsubscribing is idempotent', async () => {
		const seen: unknown[] = [];
		const stop = db.kv.subscribe(() => seen.push('kv'));
		expect(seen).toEqual([]);

		db.kv.update({ theme: 'dark' });
		expect(seen).toHaveLength(1);

		stop();
		stop();
		db.kv.update({ theme: 'light' });

		expect(seen).toHaveLength(1);
	});
});

describe('kv survives a declaration upgrade (ADR-0240)', () => {
	test('a stored write outlives the runtime that wrote it', async () => {
		// The upgrade is a close and a reopen (ADR-0240): the same durable
		// record, a newer declaration, one runtime at a time.
		const record = createMemoryRecord();
		const first = await openMemory(database, record);
		first.kv.update({ theme: 'dark' });
		first.kv.update({ future: 'kept' } as never);
		await first[Symbol.asyncDispose]();

		const second = await openMemory(
			defineStore({
				id: 'so.epicenter.honeycrisp',
				kv: {
					theme: field.select(['light', 'dark']),
					added: field.string(),
					future: field.string(),
				},
				tables: {
					notes: defineTable({
						fields: {
							title: field.string(),
							tags: field.tags(),
							date: field.nullable(field.string()),
						},
						body: plainText(),
					}),
				},
			}),
			record,
		);
		// The stored write survives the upgrade. The newly declared field remains
		// missing, so recovery belongs to the application that opened the data.
		expect(second.kv.get('theme')).toBe('dark');
		expect(second.kv.get('future' as never) as unknown).toBe('kept');
		expect(second.kv.get('added' as never) as unknown).toBeUndefined();
		expect(second.kv.nonconforming.map(({ field }) => field)).toEqual([
			'added',
		]);
		await second[Symbol.asyncDispose]();
	});
});

describe('an undeclared table waits in the CRDT (ADR-0240)', () => {
	const withScratch = defineStore({
		id: 'so.epicenter.honeycrisp',
		kv: { theme: field.select(['light', 'dark']) },
		tables: {
			notes: defineTable({
				fields: {
					title: field.string(),
				},
				body: plainText(),
			}),
			scratch: defineTable({
				fields: {
					content: field.string(),
				},
				body: plainText(),
			}),
		},
	});
	const withoutScratch = defineStore({
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

	test('the next runtime has no handle; one that re-declares it reads every row back', async () => {
		const record = createMemoryRecord();
		const first = await openMemory(withScratch, record);
		const made = first.tables.scratch.create({ content: 'kept in the CRDT' });
		first.kv.update({ theme: 'dark' });
		await first[Symbol.asyncDispose]();

		// The device updates (ADR-0240): the same durable record, the next
		// runtime, a declaration that no longer names `scratch` or `kv`.
		const second = await openMemory(withoutScratch, record);
		expect((second.tables as Record<string, unknown>).scratch).toBeUndefined();
		await second[Symbol.asyncDispose]();

		// A later release declares them again: nothing was lost, because the
		// CRDT is the truth and never dropped a byte.
		const third = await openMemory(withScratch, record);
		expect(third.tables.scratch.rows).toMatchObject([
			{ id: made.id, content: 'kept in the CRDT' },
		]);
		expect(third.kv.get('theme')).toBe('dark');
		await third[Symbol.asyncDispose]();
	});

	test('stored() sees the table and the kv key the declaration dropped', async () => {
		const record = createMemoryRecord();
		const first = await openMemory(withScratch, record);
		const made = first.tables.scratch.create({ content: 'kept in the CRDT' });
		first.kv.update({ theme: 'dark' });
		await first[Symbol.asyncDispose]();

		const second = await openMemory(withoutScratch, record);
		// The lens cannot reach them: there is no handle for `scratch`, and this
		// declaration names no kv keys at all.
		expect((second.tables as Record<string, unknown>).scratch).toBeUndefined();

		// The artifact read does, because it enumerates the roots the document
		// holds rather than the tables the declaration names.
		const state = second.stored();
		expect([...state.tables.keys()]).toEqual(['notes', 'scratch']);
		expect(state.tables.get('scratch')?.get(made.id)).toEqual({
			content: 'kept in the CRDT',
		});
		expect(state.kv).toEqual({ theme: 'dark' });
		await second[Symbol.asyncDispose]();
	});
});

describe('stored() is the faithful read (ADR-0267)', () => {
	const withPreview = defineStore({
		id: 'so.epicenter.honeycrisp',
		kv: {},
		tables: {
			notes: defineTable({
				fields: {
					title: field.string(),
					preview: field.string(),
				},
				body: plainText(),
			}),
		},
	});
	const withoutPreview = defineStore({
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

	test('a field the declaration dropped survives here and nowhere else', async () => {
		const record = createMemoryRecord();
		const before = await openMemory(withPreview, record);
		const made = before.tables.notes.create({
			title: 'Groceries',
			preview: 'milk, eggs',
		});
		await before[Symbol.asyncDispose]();

		// The release stops declaring `preview`. The row still CONFORMS, because
		// every field this declaration names reads fine, so it is not reported as
		// nonconforming either. Through the lens the stored value is unreachable
		// from both arms, which is exactly the data loss an export must not copy.
		const after = await openMemory(withoutPreview, record);
		const listed = after.tables.notes;
		expect(listed.nonconforming).toEqual([]);
		expect(listed.rows).toMatchObject([{ id: made.id, title: 'Groceries' }]);

		expect(after.stored().tables.get('notes')?.get(made.id)).toEqual({
			title: 'Groceries',
			preview: 'milk, eggs',
		});
		await after[Symbol.asyncDispose]();
	});

	test('a deleted row is absent rather than empty', async () => {
		const made = note();
		db.tables.notes.delete(made.id);
		expect(db.stored().tables.get('notes')?.has(made.id)).toBe(false);
	});
});

describe('foreign bytes have exactly one door', () => {
	// The store's updateV2 listener treats any unrecognized origin as an
	// application writing through a live body node, which is only correct for a
	// LOCAL transaction. An application holds a body node and a body node
	// exposes `.doc`, so the branch is guarded by `transaction.local` rather
	// than by convention: `applyUpdateV2` forces it to false and a local
	// `transact` defaults it to true. This test also pins `transaction.local`
	// itself: if an rc removed the field, every application write into a body
	// node would take the throw and the suite fails loudly.
	test('a direct Y.applyUpdateV2 on the live document throws instead of forging authored work', () => {
		const made = note({ title: 'mine' });
		const live = db.tables.notes.body(made.id)?.doc;
		if (live === null || live === undefined) {
			throw new Error('the body node is not attached to a document');
		}

		const stranger = new Y.Doc({ gc: true });
		const text = stranger.get('body', 'text' as never);
		stranger.transact(() =>
			text.applyDelta(text.change.insert('theirs') as never),
		);
		const foreign = new Uint8Array(Y.encodeStateAsUpdateV2(stranger));
		stranger.destroy();

		expect(() =>
			Y.applyUpdateV2(live, foreign as Uint8Array<ArrayBuffer>),
		).toThrow('applyRemote');

		// The throw fired before anything persisted, so the store is not
		// poisoned: local work still commits.
		const after = db.tables.notes.create({
			title: 'still works',
			tags: [],
			date: null,
		});
		expect(after.id).toHaveLength(24);
	});
});

describe('a store is truth plus debts (ADR-0238)', () => {
	test('a refused durable flush leaves the store live and reports blocked', async () => {
		// The withdrawn poison (ADR-0238): storage failing is a visible debt,
		// never the store's death. The live document is the truth while open.
		const raw = new Database(':memory:');
		const sqlite = createBunSqliteAdapter(raw);
		const bound = await openAccountStore({
			definition: database,
			sqlite,
			// The refused flush is the subject here, not noise worth printing.
			log: {
				error: () => undefined,
				warn: () => undefined,
				info: () => undefined,
				debug: () => undefined,
				trace: () => undefined,
			},
		});
		const store = bound;
		// Pull durable storage out from under a live document.
		raw.close();

		const made = bound.tables.notes.create({
			title: 'still accepted',
			tags: [],
			date: null,
		});
		expect(made.id).toHaveLength(24);
		// Reads follow the accepted edit immediately.
		expect(bound.tables.notes.rows.map((row) => row.title)).toEqual([
			'still accepted',
		]);
		// The debt is visible: a restart would lose this edit, and the status
		// says so instead of an exception pretending the data is gone now.
		await store.persistence.flush();
		expect(store.persistence.get()).toBe('blocked');
	});
});

describe('a body node carries its own change signal (ADR-0297)', () => {
	test('an edit to the field reaches its subscriber', () => {
		const made = note();
		const body = db.tables.notes.body(made.id);
		if (body === undefined) throw new Error('the row has no body');
		let fired = 0;
		db.tables.notes.watch(editorOf(made.id), () => {
			fired += 1;
		});
		body.applyDelta(body.change.insert('milk') as never);
		expect(fired).toBe(1);
	});

	test('a value write on the same row does not fire it', () => {
		// Why the signal is scoped to the FIELD rather than to the row. An
		// application hangs its own `updatedAt` write on this, and a row-scoped
		// signal would fire on the write it caused, so every application would
		// have to break its own loop.
		const made = note();
		let fired = 0;
		db.tables.notes.watch(editorOf(made.id), () => {
			fired += 1;
		});
		db.tables.notes.update(made.id, { title: 'Groceries and milk' });
		expect(fired).toBe(0);
	});

	test('unsubscribing stops delivery, and doing it twice is harmless', () => {
		const made = note();
		const body = db.tables.notes.body(made.id);
		if (body === undefined) throw new Error('the row has no body');
		let fired = 0;
		const stop = db.tables.notes.watch(editorOf(made.id), () => {
			fired += 1;
		});
		stop();
		stop();
		body.applyDelta(body.change.insert('milk') as never);
		expect(fired).toBe(0);
	});

	test('it fires once per commit, after the table subscriber', () => {
		// The order is the contract an application's own derived write depends
		// on: by the time this runs, every coarser reader has already seen the
		// commit that caused it, so a write made here is one commit later rather
		// than a re-entry into the one being accepted.
		const made = note();
		const body = db.tables.notes.body(made.id);
		if (body === undefined) throw new Error('the row has no body');
		const order: string[] = [];
		db.onCommitted(() => order.push('committed'));
		db.tables.notes.subscribe(() => order.push('table'));
		db.tables.notes.watch(editorOf(made.id), () => order.push('field'));

		db.transact(() => {
			body.applyDelta(body.change.insert('a') as never);
			body.applyDelta(body.change.insert('b') as never);
		});
		// No 'table': a node edit is not a table event. The phase ORDER is still the
		// contract, which is what a commit touching both halves shows.
		expect(order).toEqual(['committed', 'field']);

		order.length = 0;
		db.transact(() => {
			db.tables.notes.update(made.id, { title: 'renamed' });
			body.applyDelta(body.change.insert('c') as never);
		});
		expect(order).toEqual(['committed', 'table', 'field']);
	});

	test('a remote edit to the field reaches it too', async () => {
		const made = note();
		const laptop = await openMemory(database);
		syncEngineOf(laptop).applyRemote(db.encodeStateSince());

		const here = db.tables.notes.get(made.id);
		if (here === undefined) throw new Error('the row has no body');
		let fired = 0;
		db.tables.notes.watch(editorOf(made.id), () => {
			fired += 1;
		});

		const there = laptop.tables.notes.body(made.id);
		there?.applyDelta(there.change.insert('typed elsewhere') as never);
		syncEngineOf(db).applyRemote(laptop.encodeStateSince());

		expect(fired).toBeGreaterThan(0);
		expect(db.tables.notes.body(here.id)!.toString()).toContain(
			'typed elsewhere',
		);
	});
});

describe('the store manages no timestamps (ADR-0297)', () => {
	test('a declared instant field is an ordinary field nobody stamps', async () => {
		// `field.instant()` is a type, not a contract. The platform stops
		// holding an opinion about time: a table that wants recency declares
		// the field and writes it, and what it stores is exactly that.
		const timed = defineStore({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: {
				notes: defineTable({
					fields: {
						title: field.string(),
						updatedAt: field.instant(),
					},
					body: plainText(),
				}),
			},
		});
		const data = await openMemory(timed);
		const written = InstantString.fromDate(new Date(0));
		const made = data.tables.notes.create({
			title: 'Groceries',
			updatedAt: written,
		});
		expect(made.updatedAt).toBe(written);
		data.tables.notes.update(made.id, { title: 'Groceries and milk' });
		expect(data.tables.notes.get(made.id)?.updatedAt).toBe(written);
	});

	test('a table declaring no timestamp stores none', async () => {
		const plain = defineStore({
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
		const data = await openMemory(plain);
		const made = data.tables.notes.create({ title: 'Groceries' });
		// Its id, its declared value, and the node every row has. No timestamp,
		// which is the claim: the store stamps nothing (ADR-0297).
		expect(Object.keys(made).sort()).toEqual(['id', 'title']);
	});
});
