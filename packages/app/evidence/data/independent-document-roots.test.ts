import { expect, test } from 'bun:test';
import * as Y from '@y/y';

test('concurrent first creation of one named root in independent docs converges', () => {
	// Two devices, same document address, neither has ever seen the other.
	const a = new Y.Doc({ gc: true });
	const b = new Y.Doc({ gc: true });

	// Each mints the root by name and writes into it while partitioned.
	// `Doc.get`'s rc typing spells the type name as `never`, and `change`
	// builds the delta shape `applyDelta` spells the same way.
	a.transact(() => {
		const editor = a.get('editor', 'text' as never);
		editor.applyDelta(editor.change.insert('from A. ') as never);
	});
	b.transact(() => {
		const editor = b.get('editor', 'text' as never);
		editor.applyDelta(editor.change.insert('from B. ') as never);
	});

	// Exchange full states both ways.
	Y.applyUpdateV2(a, Y.encodeStateAsUpdateV2(b));
	Y.applyUpdateV2(b, Y.encodeStateAsUpdateV2(a));

	const textA = (a.get('editor') as Y.Type).toString();
	const textB = (b.get('editor') as Y.Type).toString();
	// Both writes survive on both sides: a name-addressed root has one logical
	// identity, unlike a nested type addressed by the operation that made it.
	expect(textA).toBe(textB);
	expect(textA).toContain('from A. ');
	expect(textA).toContain('from B. ');

	// Same with attribute (map-style) roots.
	// Attribute keys and values go through the rc typing's `never` parameters;
	// strings and numbers are what the runtime accepts.
	const c = new Y.Doc({ gc: true });
	const d = new Y.Doc({ gc: true });
	c.transact(() => c.get('meta').setAttr('x' as never, 1 as never));
	d.transact(() => d.get('meta').setAttr('y' as never, 2 as never));
	Y.applyUpdateV2(c, Y.encodeStateAsUpdateV2(d));
	Y.applyUpdateV2(d, Y.encodeStateAsUpdateV2(c));
	expect(c.get('meta').getAttr('x' as never)).toBe(1);
	expect(c.get('meta').getAttr('y' as never)).toBe(2);
	expect(d.get('meta').getAttr('x' as never)).toBe(1);
	expect(d.get('meta').getAttr('y' as never)).toBe(2);
});
