import { defineApp, defineTable, field, plainText } from '@epicenter/app';
/**
 * What a note list costs while somebody types, and whether the fine-grained
 * signal is what protects it.
 *
 * Run: `bun run evidence/bench/list-per-keystroke.ts`
 *
 * ADR-0294 measured the document and declared that "memory is the only
 * constraint; time is not". That is a statement about opening and reading a
 * document, and it is true. It is not a statement about the SCREEN, and the
 * two-signal design (`subscribe` for a table's shape, `watch` for one live
 * type) is defended entirely by a screen cost nobody has instrumented.
 *
 * The question this answers is narrower and decidable. Honeycrisp sorts notes
 * by `updatedAt` and writes `{ title, updatedAt }` back to the row from a
 * coalescer hung on the node signal, so a keystroke in an open note produces
 * TWO commits: the node edit, and the derived row write. The list must wake
 * for the second one under any design, because the note it names has just
 * moved to the top.
 *
 * So the fine signal does not spare the list a wake-up. It halves them:
 *
 *   three signals   the list re-derives once per keystroke  (the row write)
 *   one signal      the list re-derives twice               (node, then row)
 *
 * What that costs is a number, and this is the number.
 *
 * METHOD:
 *   - The REAL store (`openMemory`), not a hand-rolled Yjs model. Every
 *     earlier attempt in this subsystem to reason from a model gave the wrong
 *     answer, three separate times.
 *   - `visibleNotes` is reproduced exactly as the application derives it: read
 *     `rows`, drop the deleted, sort by `updatedAt` descending.
 *   - The corpus build is outside the timed region.
 *   - A LIVENESS control: every case asserts the derive returned the rows it
 *     should have and that the typed character actually landed, so a case that
 *     silently measured nothing reads as a failure rather than as a win.
 */

import { InstantString } from '../../../src/data/field/index.js';
import { openMemory } from '../../../src/data/store/memory.js';

const definition = defineApp({
	id: 'so.epicenter.honeycrisp',
	kv: { theme: field.select(['light', 'dark']) },
	tables: {
		notes: defineTable({
			title: field.string(),
			pinned: field.boolean(),
			folderId: field.nullable(field.string()),
			deletedAt: field.nullable(field.string()),
			updatedAt: field.string(),
			content: plainText(),
		}),
	},
});

const BODY =
	'A note body of a few hundred characters, which is what a real one is. '.repeat(
		4,
	);

/** The application's own derive, reproduced: what the list reads per wake-up. */
function visibleNotes(
	db: Awaited<ReturnType<typeof openMemory<typeof definition>>>,
) {
	return db.tables.notes.rows
		.filter((note) => note.deletedAt === null)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function ms(run: () => void, times: number): number {
	const start = Bun.nanoseconds();
	for (let i = 0; i < times; i += 1) run();
	return (Bun.nanoseconds() - start) / 1e6 / times;
}

const SIZES = [1_500, 10_000, 50_000];

console.log(
	'notes'.padStart(7),
	'rows walk'.padStart(11),
	'filter'.padStart(9),
	'sort'.padStart(9),
	'one derive'.padStart(12),
	'node'.padStart(13),
	'row write'.padStart(11),
	'| 3 sig'.padStart(11),
	'1 sig'.padStart(9),
);

for (const size of SIZES) {
	const db = await openMemory(definition);
	const ids: string[] = [];
	db.transact(() => {
		for (let i = 0; i < size; i += 1) {
			const row = db.tables.notes.create({
				title: `Note ${i}`,
				pinned: false,
				folderId: null,
				deletedAt: null,
				updatedAt: InstantString.now(),
			});
			// The content node is minted by `create` and written into after, the
			// way an editor writes it. It is never passed as a field.
			row.content.insert(0, BODY);
			ids.push(row.id);
		}
	});

	const typed = ids[0];
	if (typed === undefined) throw new Error('no rows built');
	const content = db.tables.notes.get(typed)?.content;
	if (content === undefined) throw new Error('the note has no content node');

	// Liveness: the derive sees every row, and the typed character lands.
	const derived = visibleNotes(db);
	if (derived.length !== size)
		throw new Error(`derive saw ${derived.length} of ${size}`);
	const before = content.length;
	content.insert(before, 'x');
	if (content.length !== before + 1)
		throw new Error('the typed character did not land');

	const rowsOnly = ms(() => {
		db.tables.notes.rows;
	}, 20);
	const filtered = ms(() => {
		db.tables.notes.rows.filter((note) => note.deletedAt === null);
	}, 20);
	const derive = ms(() => {
		visibleNotes(db);
	}, 20);
	const nodeEdit = ms(() => {
		content.insert(content.length, 'x');
	}, 200);
	const rowWrite = ms(() => {
		db.tables.notes.update(typed, {
			title: 'Note 0',
			updatedAt: InstantString.now(),
		});
	}, 200);

	const threeSignals = nodeEdit + rowWrite + derive;
	const oneSignal = nodeEdit + rowWrite + derive * 2;

	console.log(
		String(size).padStart(7),
		`${rowsOnly.toFixed(2)} ms`.padStart(11),
		`${(filtered - rowsOnly).toFixed(2)} ms`.padStart(9),
		`${(derive - filtered).toFixed(2)} ms`.padStart(9),
		`${derive.toFixed(2)} ms`.padStart(12),
		`${nodeEdit.toFixed(3)} ms`.padStart(13),
		`${rowWrite.toFixed(3)} ms`.padStart(11),
		`| ${threeSignals.toFixed(1)} ms`.padStart(11),
		`${oneSignal.toFixed(1)} ms`.padStart(9),
	);

	await db[Symbol.asyncDispose]();
}

console.log(
	'\nPer keystroke, store side only. The DOM is not in these numbers:',
);
console.log('a re-derive hands the list a fresh array of fresh row objects,');
console.log('so the framework re-renders whatever it is bound to on top.');
