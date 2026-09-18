/**
 * What a detached `Y.Type` can and cannot do, pinned.
 *
 * A codec builds its own content node and hands it to `create` (ADR-0296, as
 * amended), so what a detached type is safe for is now a correctness
 * constraint on every codec anyone writes. This file is that constraint, in
 * executable form, because `@y/y` is an RC and the amendment is only as good as
 * the behaviour it rests on.
 *
 * The rule in one sentence: **a detached type accumulates one prelim delta, and
 * a delta is positional.** Anything computed against the state it will actually
 * land on is safe; a sequence of independent positional writes is not, because
 * each is computed against an empty type and they all land at index 0.
 */
import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';

/** Attach a type the way `createRow` does, and read it back through the row. */
function integrate(type: Y.Type): Y.Type {
	const document = new Y.Doc({ gc: true });
	const root = document.get('root');
	document.transact(() => {
		root.setAttr('r' as never, type as never);
	});
	return root.getAttr('r' as never) as Y.Type;
}

const named = (...names: string[]) => names.map((name) => new Y.Type(name));

describe('a detached type is SAFE for', () => {
	test('one bulk insert, which is what `pmToFragment` produces', () => {
		const type = new Y.Type();
		type.insert(0, named('a', 'b', 'c'));
		expect(integrate(type).toString()).toBe('<a /><b /><c />');
	});

	test('one text insert', () => {
		const type = new Y.Type();
		type.insert(0, ['hello world']);
		expect(integrate(type).toString()).toBe('hello world');
	});

	test('repeated attribute writes, which is what a map-shaped codec does', () => {
		// Not positional, so nothing can be computed against the wrong state.
		// `packages/chat` writes its message log exactly this way.
		const type = new Y.Type();
		type.setAttr('k1' as never, 1 as never);
		type.setAttr('k2' as never, 2 as never);
		type.setAttr('k3' as never, 3 as never);
		const live = integrate(type);
		expect(live.getAttr('k2' as never)).toBe(2);
		expect(live.getAttr('k3' as never)).toBe(3);
	});
});

describe('a detached type is UNSAFE for', () => {
	test('repeated positional appends, which REVERSE and do not throw', () => {
		// The trap, and the reason this file exists. ADR-0296 recorded it and it
		// is real: each `push` is computed against an empty type, so all three
		// land at index 0 and the last one written is first. Attached, the same
		// loop is correct. A codec that builds content in a loop of appends is
		// silently wrong, which is worse than broken.
		const type = new Y.Type();
		for (const child of named('a', 'b', 'c')) type.push([child]);
		expect(integrate(type).toString()).toBe('<c /><b /><a />');

		const attached = integrate(new Y.Type());
		for (const child of named('a', 'b', 'c')) attached.push([child]);
		expect(attached.toString()).toBe('<a /><b /><c />');
	});

	test('being read before it is integrated', () => {
		// Content lives in the prelim delta until `_integrate` replays it, so a
		// codec must build, fill, and hand over without reading back.
		const type = new Y.Type();
		type.insert(0, named('a'));
		expect(type.length).toBe(0);
		expect(integrate(type).length).toBe(1);
	});
});

describe('what is NOT about detachment', () => {
	test('the failing `insert` pair fails attached too', () => {
		// ADR-0296 cited this as evidence for the attached signature. It is a
		// defect in that call shape, present either way, so it never argued for
		// one design over the other. What differs is only WHEN: attached it
		// throws on the second call, detached it buffers and throws when the
		// prelim delta is replayed at integrate.
		const twoInserts = (type: Y.Type) => {
			type.insert(0, ['hello ']);
			type.insert(6, ['world']);
		};
		expect(() => twoInserts(integrate(new Y.Type()))).toThrow(
			'Exceeded content range',
		);
		const detached = new Y.Type();
		twoInserts(detached);
		expect(() => integrate(detached)).toThrow('Exceeded content range');
	});
});

describe('what a fresh `new Y.Type()` gives you', () => {
	test('a fresh type, owned by no document', () => {
		expect(new Y.Type().doc).toBeNull();
		expect(new Y.Type()).not.toBe(new Y.Type());
	});

	test('a whole conversion reaches a peer identically either way', () => {
		// The claim the amendment turns on: built detached and integrated, a real
		// document is byte-identical on the wire to one built attached.
		const build = (detached: boolean): Y.Doc => {
			const document = new Y.Doc({ gc: true });
			const root = document.get('root');
			const children = () =>
				named(...Array.from({ length: 50 }, (_, i) => `p${i}`));
			if (detached) {
				const type = new Y.Type();
				type.insert(0, children());
				document.transact(() => root.setAttr('r' as never, type as never));
				return document;
			}
			document.transact(() =>
				root.setAttr('r' as never, new Y.Type() as never),
			);
			(root.getAttr('r' as never) as Y.Type).insert(0, children());
			return document;
		};
		const seenBy = (document: Y.Doc): string => {
			const peer = new Y.Doc({ gc: true });
			Y.applyUpdateV2(peer, Y.encodeStateAsUpdateV2(document));
			return (peer.get('root').getAttr('r' as never) as Y.Type).toString();
		};
		expect(seenBy(build(true))).toBe(seenBy(build(false)));
		// Same size to the byte, allowing for the client id: a `Doc` mints a
		// random one and it is varint-encoded, so two documents can differ by a
		// byte or two without anything about the content differing.
		const detachedBytes = Y.encodeStateAsUpdateV2(build(true)).byteLength;
		const attachedBytes = Y.encodeStateAsUpdateV2(build(false)).byteLength;
		expect(Math.abs(detachedBytes - attachedBytes)).toBeLessThanOrEqual(4);
	});
});
