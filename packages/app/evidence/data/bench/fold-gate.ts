/** Cost of the fold gate on the real SQLite port, before and after. */
import { Database } from 'bun:sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { createSqliteDurablePort } from '../../../src/data/store/log.js';

function workspace(notes: number, words: number) {
	const doc = new Y.Doc({ gc: true });
	const table = doc.get('tables:notes');
	doc.transact(() => {
		for (let i = 0; i < notes; i += 1) {
			const row = new Y.Node();
			const content = new Y.Node();
			content.insert(0, 'lorem ipsum dolor sit amet '.repeat(words / 5));
			row.setAttr('content', content as never);
			table.setAttr(`n${i}`, row as never);
		}
	});
	return { doc, table };
}

function run(edits: number, batch: number, notes: number, words: number) {
	const sqlite = createBunSqliteAdapter(new Database(':memory:'));
	const port = createSqliteDurablePort({ sqlite });
	const { doc, table } = workspace(notes, words);

	const pending: Uint8Array[] = [];
	doc.on('updateV2', (u: Uint8Array) => pending.push(u));

	let id = 1;
	port.commit([
		{
			kind: 'append',
			id: id++,
			bytes: new Uint8Array(Y.encodeStateAsUpdateV2(doc)),
			authoritySeq: undefined,
		},
	]);
	pending.length = 0;

	const baseline = Y.encodeStateAsUpdateV2(doc).byteLength;
	const start = Bun.nanoseconds();
	const ops: any[] = [];
	for (let i = 0; i < edits; i += 1) {
		const row = table.getAttr(`n${i % notes}`) as any;
		const content = row.getAttr('content') as any;
		doc.transact(() => content.insert(content.length, 'more words here '));
		for (const u of pending.splice(0, pending.length)) {
			ops.push({ kind: 'append', id: id++, bytes: u, authoritySeq: undefined });
		}
		if (ops.length >= batch) {
			port.commit(ops.splice(0, ops.length));
		}
	}
	if (ops.length > 0) port.commit(ops);
	const ms = (Bun.nanoseconds() - start) / 1e6;
	const rows = sqlite.all<any>('SELECT COUNT(*) AS n FROM _updates')[0].n;
	return { ms, rows, baseline };
}

const cases = [
	{ edits: 2000, batch: 1, notes: 300, words: 200 },
	{ edits: 2000, batch: 25, notes: 300, words: 200 },
	{ edits: 2000, batch: 25, notes: 1500, words: 400 },
];
for (const c of cases) {
	const r = run(c.edits, c.batch, c.notes, c.words);
	console.log(
		`edits=${c.edits} batch=${c.batch} baseline=${(r.baseline / 1024).toFixed(0)}KB` +
			`  ->  ${r.ms.toFixed(0)} ms, ${r.rows} rows left`,
	);
}
