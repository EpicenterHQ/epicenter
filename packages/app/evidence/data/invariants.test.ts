/**
 * The Yjs behaviour Epicenter's data model depends on, pinned.
 *
 * Every assertion here is a property of `@y/y@14.0.0-rc.24` rather than of
 * Epicenter's own code. They live in a test because they are load-bearing
 * design premises taken from a release candidate, and an rc can move them
 * quietly: one of them, that a type's behaviour comes from its name, was
 * asserted in a record as "verified" and turned out to be false.
 *
 * A failure here is not a bug in the store. It means an upgrade changed
 * something a decision was resting on, and the decision has to be re-read.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';

import {
	createDatabaseDocument,
	KV_ROOT_NAME,
	kvRoot,
	tableRoot,
	tableRootName,
} from '../../src/data/store/document.js';
import { asValues, putRow, rowAt, type ValuesType } from './raw-document.js';

/** Exchange everything each side is missing, both directions. */
function sync(a: Y.Doc, b: Y.Doc): void {
	const fromA = Y.encodeStateAsUpdateV2(a, Y.encodeStateVector(b));
	const fromB = Y.encodeStateAsUpdateV2(b, Y.encodeStateVector(a));
	Y.applyUpdateV2(b, fromA);
	Y.applyUpdateV2(a, fromB);
}

/**
 * Every attribute on one type, or on nothing.
 *
 * `undefined` is admitted so a caller can hand `rowAt`'s answer straight in:
 * an assertion against `{}` is the same failure as an assertion against the
 * wrong contents, and it reads at the call site instead of a guard above it.
 */
function attrs(type: Y.Type | undefined): Record<string, unknown> {
	return (type?.getAttrs() ?? {}) as Record<string, unknown>;
}

describe('the database document has one named root grammar', () => {
	test('uses kv and tables:<name> without a nested tables root', () => {
		const document = createDatabaseDocument();
		const kv = asValues(kvRoot(document));
		const pages = tableRoot(document, 'pages');
		const folders = tableRoot(document, 'folders');

		document.transact(() => {
			kv.setAttr('theme', 'dark');
			const page: ValuesType = new Y.Type();
			page.setAttr('title', 'A page');
			putRow(pages, 'page-1', page);
			putRow(folders, 'folder-1', new Y.Type());
		});

		expect(KV_ROOT_NAME).toBe('kv');
		expect(tableRootName('pages')).toBe('tables:pages');
		expect([...document.share.keys()]).toEqual([
			'kv',
			'tables:pages',
			'tables:folders',
		]);
		expect(attrs(document.get('kv'))).toEqual({ theme: 'dark' });
		expect(attrs(rowAt(document.get('tables:pages'), 'page-1'))).toEqual({
			title: 'A page',
		});
		expect(document.share.has('tables')).toBe(false);
	});
});

describe('identity: a root is addressed by name, a nested type by struct', () => {
	test('two devices independently minting the SAME ROOT converge', () => {
		// Why KV lives at a reserved root. `Doc.get` is `setIfUndefined` on
		// `doc.share`, so the name IS the identity and independent minting is not
		// a conflict.
		const phone = new Y.Doc({ gc: true });
		const laptop = new Y.Doc({ gc: true });
		phone.get('kv');
		laptop.get('kv');
		phone.transact(() => asValues(phone.get('kv')).setAttr('theme', 'dark'));
		laptop.transact(() => asValues(laptop.get('kv')).setAttr('fontSize', 22));
		sync(phone, laptop);

		expect(attrs(phone.get('kv'))).toEqual({ theme: 'dark', fontSize: 22 });
		expect(attrs(laptop.get('kv'))).toEqual({ theme: 'dark', fontSize: 22 });
		expect([...phone.share.keys()]).toEqual(['kv']);
	});

	test('two devices independently minting the SAME NESTED TYPE lose one subtree', () => {
		// The failure this whole model is arranged to avoid. Map LWW keeps one
		// container and discards the other along with everything inside it, so a
		// chosen address written by two devices is not safe.
		const phone = new Y.Doc({ gc: true });
		const laptop = new Y.Doc({ gc: true });
		for (const [doc, key, value] of [
			[phone, 'theme', 'dark'],
			[laptop, 'fontSize', 22],
		] as const) {
			doc.transact(() => {
				const container: ValuesType = new Y.Type();
				putRow(doc.get('settings'), 'app', container);
				container.setAttr(key, value);
			});
		}
		sync(phone, laptop);

		const read = (doc: Y.Doc) => attrs(rowAt(doc.get('settings'), 'app'));
		// Converged, and one device's write is simply gone.
		expect(read(phone)).toEqual(read(laptop));
		expect(Object.keys(read(phone))).toHaveLength(1);
	});

	test('per-field merge is correct once the container exists', () => {
		// The safe case, and the reason minted ids are fine: create once, then
		// every field merges independently.
		const phone = new Y.Doc({ gc: true });
		const laptop = new Y.Doc({ gc: true });
		phone.transact(() => {
			const row: ValuesType = new Y.Type();
			putRow(phone.get('notes'), 'n1', row);
			row.setAttr('title', 'original');
		});
		sync(phone, laptop);

		const rowOf = (doc: Y.Doc): ValuesType => {
			const found = rowAt(doc.get('notes'), 'n1');
			if (found === undefined) throw new Error('the row is gone');
			return found;
		};
		phone.transact(() => rowOf(phone).setAttr('title', 'phone'));
		laptop.transact(() => rowOf(laptop).setAttr('date', '2026-08-07'));
		sync(phone, laptop);

		expect(attrs(rowOf(phone))).toEqual({ title: 'phone', date: '2026-08-07' });
		expect(attrs(rowOf(laptop))).toEqual(attrs(rowOf(phone)));
	});
});

describe('a state vector cannot express deletion', () => {
	test('two documents that disagree about a key hold IDENTICAL state vectors', () => {
		// The property that killed two authority designs, and the reason the
		// transport carries an integer log position instead. A delete marks an
		// existing struct rather than writing a new one, so no clock moves, so
		// "have I caught up" is a question a state vector cannot answer.
		const kept = new Y.Doc({ gc: true });
		kept.transact(() => {
			asValues(kept.get('notes')).setAttr('x', 1);
			asValues(kept.get('notes')).setAttr('y', 2);
		});
		const removed = new Y.Doc({ gc: true });
		Y.applyUpdateV2(removed, Y.encodeStateAsUpdateV2(kept));
		removed.transact(() => removed.get('notes').deleteAttr('y'));

		expect(Y.encodeStateVector(removed)).toEqual(Y.encodeStateVector(kept));
		expect(attrs(kept)).toEqual({ x: 1, y: 2 });
		expect(attrs(removed)).toEqual({ x: 1 });

		function attrs(doc: Y.Doc): Record<string, unknown> {
			return doc.get('notes').getAttrs() as Record<string, unknown>;
		}
	});

	test('a diff still carries the delete, so the bytes are not lost with it', () => {
		// The reassuring half, and it has to be stated too or the rule above reads
		// as "deletes do not replicate". They do: `encodeStateAsUpdateV2` writes
		// the whole delete set regardless of the state vector it is diffed
		// against. What is unavailable is the INFERENCE, not the data.
		const kept = new Y.Doc({ gc: true });
		kept.transact(() => {
			asValues(kept.get('notes')).setAttr('x', 1);
			asValues(kept.get('notes')).setAttr('y', 2);
		});
		const removed = new Y.Doc({ gc: true });
		Y.applyUpdateV2(removed, Y.encodeStateAsUpdateV2(kept));
		removed.transact(() => removed.get('notes').deleteAttr('y'));

		// The state vectors match, so a size-zero diff would be a defensible
		// implementation. It is not what happens.
		const diff = Y.encodeStateAsUpdateV2(removed, Y.encodeStateVector(kept));
		expect(diff.length).toBeGreaterThan(0);
		Y.applyUpdateV2(kept, diff);
		expect(kept.get('notes').getAttrs()).toEqual({ x: 1 });
	});
});

describe('delivery: what the transport must guarantee', () => {
	test('a nested-container update with missing dependencies is buffered SILENTLY', () => {
		// The most dangerous property in the library for this design, and it fires
		// on the exact shape a row has: create the container, then set a field in
		// it. No throw, no event, no public reader, empty document.
		// `hasUnresolvedDependencies()` in the store exists because of this.
		const origin = new Y.Doc({ gc: true });
		let row!: ValuesType;
		origin.transact(() => {
			row = new Y.Type();
			putRow(origin.get('notes'), 'n1', row);
		});
		const first = Y.encodeStateAsUpdateV2(origin);
		const afterFirst = Y.encodeStateVector(origin);
		origin.transact(() => row.setAttr('title', 'hello'));
		const second = Y.encodeStateAsUpdateV2(origin, afterFirst);

		const replica = new Y.Doc({ gc: true });
		let emitted = 0;
		replica.on('updateV2', () => {
			emitted += 1;
		});

		expect(() => Y.applyUpdateV2(replica, second)).not.toThrow();
		expect(emitted).toBe(0);
		expect(attrs(replica.get('notes'))).toEqual({});
		expect(pendingOf(replica)).toBe(true);

		// It resolves the moment the dependency arrives, and the resolving event
		// carries the buffered structs, which is why persisting RECEIVED bytes is
		// what makes the buffered update survive a restart.
		Y.applyUpdateV2(replica, first);
		expect(pendingOf(replica)).toBe(false);
		expect(attrs(rowAt(replica.get('notes'), 'n1'))).toEqual({
			title: 'hello',
		});
	});

	test('an editing chain inside one type buffers the same way', () => {
		// The node shape. Same silence, so an editor's updates are subject to it.
		const origin = new Y.Doc({ gc: true });
		const text = origin.get('editor', 'text');
		origin.transact(() =>
			text.applyDelta(text.change.insert('hello') as never),
		);
		const afterFirst = Y.encodeStateVector(origin);
		origin.transact(() =>
			text.applyDelta(text.change.retain(5).insert(' world') as never),
		);
		const second = Y.encodeStateAsUpdateV2(origin, afterFirst);

		const replica = new Y.Doc({ gc: true });
		Y.applyUpdateV2(replica, second);
		expect(pendingOf(replica)).toBe(true);
		expect(replica.get('editor', 'text').length).toBe(0);
	});

	test('a gap in independent map keys is honest, and a normal sync heals it', () => {
		// The reassuring half, and worth pinning so the rule is not overstated.
		// Two sets of DIFFERENT keys on one map root are independent, so the
		// second applies alone with nothing pending and a partial document. That
		// is safe, because the state vector still reports the gap and an ordinary
		// exchange resends what is missing. Silence is only dangerous where the
		// structs are causally chained, as in the two tests above.
		const origin = new Y.Doc({ gc: true });
		origin.transact(() =>
			origin.get('notes').setAttr('a' as never, 1 as never),
		);
		const afterFirst = Y.encodeStateVector(origin);
		origin.transact(() =>
			origin.get('notes').setAttr('b' as never, 2 as never),
		);

		const replica = new Y.Doc({ gc: true });
		Y.applyUpdateV2(replica, Y.encodeStateAsUpdateV2(origin, afterFirst));
		expect(attrs(replica.get('notes'))).toEqual({ b: 2 });
		expect(pendingOf(replica)).toBe(false);

		Y.applyUpdateV2(
			replica,
			Y.encodeStateAsUpdateV2(origin, Y.encodeStateVector(replica)),
		);
		expect(attrs(replica.get('notes'))).toEqual({ a: 1, b: 2 });
	});

	test('updates are idempotent, so duplicate delivery is free', () => {
		const origin = new Y.Doc({ gc: true });
		origin.transact(() =>
			origin.get('notes').setAttr('a' as never, 1 as never),
		);
		const update = Y.encodeStateAsUpdateV2(origin);
		const replica = new Y.Doc({ gc: true });
		for (let i = 0; i < 3; i += 1) Y.applyUpdateV2(replica, update);
		expect(attrs(replica.get('notes'))).toEqual({ a: 1 });
	});

	test('updates converge under every delivery order, given all of them arrive', () => {
		// "Any order" is true. It is conditional on completeness, which is what
		// the pending-structs test above is really about: order is free, gaps are
		// not, and a gap is invisible.
		const origin = new Y.Doc({ gc: true });
		const updates: Uint8Array[] = [];
		let seen = Y.encodeStateVector(origin);
		for (const key of ['a', 'b', 'c', 'd']) {
			origin.transact(() =>
				origin.get('notes').setAttr(key as never, key as never),
			);
			updates.push(Y.encodeStateAsUpdateV2(origin, seen));
			seen = Y.encodeStateVector(origin);
		}
		const expected = attrs(origin.get('notes'));

		for (const order of permutations([0, 1, 2, 3])) {
			const replica = new Y.Doc({ gc: true });
			for (const index of order) {
				const update = updates[index];
				if (update !== undefined) Y.applyUpdateV2(replica, update);
			}
			expect(attrs(replica.get('notes'))).toEqual(expected);
			expect(pendingOf(replica)).toBe(false);
		}
	});
});

describe('deletion against a concurrent write, and against a later one', () => {
	test('a concurrent field write does NOT resurrect the row: the delete wins', () => {
		// The case that sounds dangerous and is not. One device deletes a row
		// while another, not knowing, writes a derived field onto it. Yjs
		// resolves it: the nested type is deleted and the write goes with it.
		const phone = new Y.Doc({ gc: true });
		const laptop = new Y.Doc({ gc: true });
		phone.transact(() => {
			const row: ValuesType = new Y.Type();
			putRow(phone.get('tables:notes'), 'row1', row);
			row.setAttr('title', 'hello');
		});
		sync(phone, laptop);

		phone.transact(() => phone.get('tables:notes').deleteAttr('row1'));
		const held = rowAt(laptop.get('tables:notes'), 'row1');
		laptop.transact(() => held?.setAttr('updatedAt', '2026-08-28'));
		sync(phone, laptop);

		expect(Object.keys(attrs(phone.get('tables:notes')))).toEqual([]);
		expect(Object.keys(attrs(laptop.get('tables:notes')))).toEqual([]);
	});

	test('re-minting the type after the deletion arrived DOES bring the row back', () => {
		// The case the tombstone is actually written about, and it is not a merge
		// artifact: it is `writeRow`'s mint-if-absent path being reached at all.
		// A device that has already seen the deletion, and then writes a field,
		// creates a NEW nested type at the same key, and a new type is new data
		// rather than a revival of old data. Nothing in Yjs can refuse it,
		// because nothing in Yjs knows the key used to hold something.
		const phone = new Y.Doc({ gc: true });
		const laptop = new Y.Doc({ gc: true });
		phone.transact(() => {
			const row: ValuesType = new Y.Type();
			putRow(phone.get('tables:notes'), 'row2', row);
			row.setAttr('title', 'hi');
		});
		sync(phone, laptop);
		phone.transact(() => phone.get('tables:notes').deleteAttr('row2'));
		sync(phone, laptop);
		expect(Object.keys(attrs(laptop.get('tables:notes')))).toEqual([]);

		// Exactly what `writeRow` does when `rowType` answers undefined.
		laptop.transact(() => {
			const fresh = new Y.Type();
			putRow(laptop.get('tables:notes'), 'row2', fresh);
			fresh.setAttr('updatedAt', 'later');
		});
		sync(phone, laptop);

		expect(Object.keys(attrs(phone.get('tables:notes')))).toEqual(['row2']);
	});
});

describe('reclamation: what deletion actually returns', () => {
	test('deleting a root attribute reclaims its value', () => {
		// Nesting is not required to get a value collected, which is what makes a
		// flat reserved root a viable home for KV.
		const doc = new Y.Doc({ gc: true });
		const kv = doc.get('kv');
		doc.transact(() => kv.setAttr('big', 'x'.repeat(100_000)));
		const before = Y.encodeStateAsUpdateV2(doc).length;
		doc.transact(() => kv.deleteAttr('big'));
		const after = Y.encodeStateAsUpdateV2(doc).length;

		expect(before).toBeGreaterThan(100_000);
		expect(after).toBeLessThan(200);
	});

	test('clearing a row and flagging it costs more than dropping the container', () => {
		// Both reclaim the content. The difference is what the tombstone carries,
		// and it is the open question in ADR-0212's choice of clear-and-flag: a
		// dropped container leaves one key, while clearing leaves one per field.
		const build = () => {
			const doc = new Y.Doc({ gc: true });
			const root = doc.get('notes');
			doc.transact(() => {
				for (let index = 0; index < 200; index += 1) {
					const row: ValuesType = new Y.Type();
					putRow(root, `r${String(index).padStart(23, '0')}`, row);
					row.setAttr('!presence', 'present');
					row.setAttr('title', 'x'.repeat(200));
				}
			});
			return { doc, root };
		};

		const dropped = build();
		dropped.doc.transact(() => {
			for (const key of [...dropped.root.attrKeys()]) {
				dropped.root.deleteAttr(key as string);
			}
		});

		const cleared = build();
		cleared.doc.transact(() => {
			for (const key of [...cleared.root.attrKeys()]) {
				const row = rowAt(cleared.root, String(key));
				if (row === undefined) continue;
				for (const field of [...row.attrKeys()]) {
					if (field !== '!presence') row.deleteAttr(field);
				}
				row.setAttr('!presence', 'absent');
			}
		});

		const droppedBytes = Y.encodeStateAsUpdateV2(dropped.doc).length / 200;
		const clearedBytes = Y.encodeStateAsUpdateV2(cleared.doc).length / 200;
		expect(droppedBytes).toBeLessThan(clearedBytes);
		// Both reclaim the 200-character titles rather than merely hiding them.
		expect(clearedBytes).toBeLessThan(200);
	});
});

describe('claims a record got wrong, kept so they stay wrong', () => {
	test("a type's name does NOT gate its behaviour", () => {
		// ADR-0215 asserted, as "verified", that `doc.get('editor')` silently
		// discards inserts while `doc.get('editor', 'text')` does not. False: the
		// original probe changed two variables and never called `applyDelta`. In
		// rc.24 the name is an inert label. If a later rc makes it load-bearing,
		// this test fails and the API that passes a type name has to be re-read.
		for (const name of [null, 'text', 'map', 'array']) {
			const doc = new Y.Doc({ gc: true });
			const type = name === null ? doc.get('editor') : doc.get('editor', name);
			doc.transact(() => type.applyDelta(type.change.insert('hello') as never));
			expect(type.length).toBe(5);
		}
	});

	test('a root minted by a remote update keeps no name', () => {
		// `Doc.get(key, name)` is `setIfUndefined`, so if a remote update mints a
		// root first, a later `get` with a name is ignored and the root stays
		// nameless. Harmless while names are inert; arrival-order-dependent type
		// identity the moment they are not.
		const origin = new Y.Doc({ gc: true });
		origin.transact(() =>
			asValues(origin.get('editor', 'text')).setAttr('a', 1),
		);
		const replica = new Y.Doc({ gc: true });
		Y.applyUpdateV2(replica, Y.encodeStateAsUpdateV2(origin));

		expect(replica.get('editor', 'text').name ?? null).toBeNull();
	});
});

function pendingOf(doc: Y.Doc): boolean {
	return doc.store.pendingStructs !== null || doc.store.pendingDs !== null;
}

function permutations<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) return [[...items]];
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += 1) {
		const rest = [...items.slice(0, index), ...items.slice(index + 1)];
		for (const tail of permutations(rest)) {
			const head = items[index];
			if (head !== undefined) result.push([head, ...tail]);
		}
	}
	return result;
}
