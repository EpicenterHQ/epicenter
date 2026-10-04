/**
 * R28: does binding ProseMirror to a note's YType collide with our field attrs?
 *
 * The worry: we store title/tags/date as setAttr on the SAME YType whose
 * sequence content the editor binds to. @y/prosemirror DOES call setAttr and
 * deleteAttr (sync-utils.js:243-246), and nodeToDelta writes a node's attrs
 * (sync-utils.js:435-437). If the PM doc node's attrs (usually {}) are
 * reconciled against the root, our fields get deleted.
 *
 * Run from the epicenter repo root so @y/prosemirror and prosemirror-* resolve.
 */
import * as Y from '@y/y';

const show = (t: any) => JSON.stringify(t.getAttrs());

console.log('=== 1. baseline: fields as attrs, prose as sequence children ===');
{
	const d = new Y.Doc(); (d as any).clientID = 1;
	const note: any = d.get('notes/n1');
	note.setAttr('title', 'Groceries');
	note.setAttr('tags', ['food']);
	const p: any = new (Y as any).Type('paragraph');
	note.insert(0, [p]);
	p.insert(0, 'buy milk');
	console.log('  attrs:', show(note));
	console.log('  json :', JSON.stringify(note.toJSON()));
}

console.log('\n=== 2. THE TEST: apply a doc-shaped delta whose attrs are {} ===');
{
	const d = new Y.Doc(); (d as any).clientID = 1;
	const note: any = d.get('notes/n1');
	note.setAttr('title', 'Groceries');
	note.setAttr('tags', ['food']);
	const before = show(note);

	// what a PM reconcile looks like: a delta carrying children and NO attrs
	try {
		const { delta } = await import('@y/y/meta') as any;
		const dd = delta.create().insert(['hello']).done?.() ?? delta.create().insert(['hello']);
		note.applyDelta(dd);
	} catch {
		// fall back to the shape the binding actually produces via the public API
		note.applyDelta({ type: 'delta', children: [{ type: 'insert', insert: ['hello from the editor'] }] });
	}
	console.log(`  before: ${before}`);
	console.log(`  after : ${show(note)}`);
	console.log(`  fields survived a children-only delta? ${show(note) === before ? 'YES' : 'NO'}`);
}

console.log('\n=== 3. real @y/prosemirror, if the deps resolve ===');
try {
	const { Schema, Node } = await import('prosemirror-model') as any;
	const pmy: any = await import('@y/prosemirror');
	console.log('  @y/prosemirror exports:', Object.keys(pmy).sort().join(' '));

	const schema = new Schema({
		nodes: {
			doc: { content: 'block+' },
			paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
			text: { group: 'inline' },
		},
		marks: {},
	});
	const doc = Node.fromJSON(schema, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'buy milk' }] }] });
	console.log('  PM doc node attrs:', JSON.stringify(doc.attrs), '<- these are what would land on the ROOT');

	const d = new Y.Doc(); (d as any).clientID = 1;
	const note: any = d.get('notes/n1');
	note.setAttr('title', 'Groceries');
	note.setAttr('tags', ['food']);
	const before = show(note);

	if (typeof pmy.docToDelta === 'function' || typeof pmy.applyPMDoc === 'function') {
		const dd = (pmy.docToDelta ?? pmy.nodeToDelta)(doc);
		console.log('  docToDelta(doc) =', JSON.stringify(dd).slice(0, 200));
		note.applyDelta(dd);
		console.log(`  before: ${before}`);
		console.log(`  after : ${show(note)}`);
		console.log(`  fields survived a REAL PM doc delta? ${show(note) === before ? 'YES' : 'NO  <-- COLLISION'}`);
	} else {
		console.log('  no direct doc->delta export; exports above show what is reachable');
	}
} catch (e) {
	console.log('  could not run the real binding:', (e as Error).message);
}

console.log('\n=== 4. the safe alternative: prose in a NESTED child, fields on the root ===');
{
	const d = new Y.Doc(); (d as any).clientID = 1;
	const note: any = d.get('notes/n1');
	note.setAttr('title', 'Groceries');
	const body: any = new (Y as any).Type('body');
	note.insert(0, [body]);          // the editor binds to `body`, never to `note`
	body.insert(0, 'buy milk');
	body.setAttr('anything', 'the editor may set this freely');
	console.log('  root attrs :', show(note), '<- untouched by the editor');
	console.log('  body attrs :', show(body));
	console.log('  root json  :', JSON.stringify(note.toJSON()).slice(0, 180));
}
