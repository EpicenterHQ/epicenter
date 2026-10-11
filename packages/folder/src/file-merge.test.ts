/**
 * File Merge Tests
 *
 * Drives `mergeFile`, the one-file merge sync runs for each path, as an
 * edit session uses it: three texts in, merged text or held units out.
 *
 * Key behaviors:
 * - Independent field changes merge to the standard row text
 * - A field both changed is held alone; settling it keeps the merged fields
 * - Settling reports a missing choice and a value the schema refuses per unit
 * - A side with no file holds the whole file; taking that side answers `null`
 * - `files.merge` writes what merges over the change made elsewhere, writes
 *   resolved choices guarded by the bytes it read, refuses restoring a file
 *   deleted elsewhere when asked, and holds a file that is no longer text
 */
import { expect, test } from 'bun:test';
import type { Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { rawBrowserFolder } from './browser-storage.test-support.js';
import {
	defineFolder,
	defineTable,
	field,
	type SyncError,
} from './contract.js';
import { prepareFolderDefinition } from './definition.js';
import { createFiles } from './files.js';
import { mergeFile } from './git/sync.js';

const definition = expectOk(
	prepareFolderDefinition(
		defineFolder({
			kv: {},
			tables: {
				todos: defineTable({
					fields: { title: field.string(), done: field.boolean() },
				}),
			},
		}),
	),
);
const PATH = 'todos/milk.md';

/** The choice problems a refused settle names. */
function problemsOf(result: Result<unknown, SyncError>) {
	const error = expectErr(result);
	if (error.name !== 'InvalidChoices') throw new Error(error.message);
	return error.problems;
}
const row = (title: string, done: boolean) =>
	`---\ntitle: ${title}\ndone: ${done}\n---\n`;

test('independent field changes merge to the standard row text', async () => {
	const merged = await mergeFile(definition, PATH, {
		base: row('Milk', false),
		ours: row('Mine', false),
		theirs: row('Milk', true),
	});
	expect(merged).toEqual({ kind: 'merged', text: row('Mine', true) });
});

test('a field both changed is held alone, and settling it keeps the merged fields', async () => {
	const merged = await mergeFile(definition, PATH, {
		base: row('Milk', false),
		ours: row('Mine', false),
		theirs: row('Theirs', true),
	});
	if (merged.kind !== 'held') throw new Error('Expected a held title');
	expect(merged.conflicts.map(({ kind }) => kind)).toEqual(['field']);
	const [title] = merged.conflicts;
	if (title === undefined) throw new Error('Expected a title conflict');

	expect(
		expectOk(merged.settle({ [title.id]: { kind: 'take', side: 'local' } })),
	).toBe(row('Mine', true));
	expect(
		expectOk(merged.settle({ [title.id]: { kind: 'replace', value: 'Both' } })),
	).toBe(row('Both', true));
});

test('settling names a missing choice and a value the schema refuses', async () => {
	const merged = await mergeFile(definition, PATH, {
		base: row('Milk', false),
		ours: row('Mine', false),
		theirs: row('Theirs', false),
	});
	if (merged.kind !== 'held') throw new Error('Expected a held title');
	const [title] = merged.conflicts;
	if (title === undefined) throw new Error('Expected a title conflict');

	expect(problemsOf(merged.settle({})).map(({ reason }) => reason)).toEqual([
		'missing',
	]);
	const refused = problemsOf(
		merged.settle({ [title.id]: { kind: 'replace', value: 42 } }),
	);
	expect(refused).toMatchObject([{ conflictId: title.id, reason: 'invalid' }]);
});

test('a side with no file holds the whole file, and taking that side answers no file', async () => {
	const merged = await mergeFile(definition, PATH, {
		base: row('Milk', false),
		ours: row('Mine', false),
		theirs: null,
	});
	if (merged.kind !== 'held') throw new Error('Expected a held file');
	const [file] = merged.conflicts;
	expect(file?.kind).toBe('file');
	if (file === undefined) throw new Error('Expected a file conflict');

	expect(
		expectOk(merged.settle({ [file.id]: { kind: 'take', side: 'incoming' } })),
	).toBeNull();
	expect(
		expectOk(merged.settle({ [file.id]: { kind: 'take', side: 'local' } })),
	).toBe(row('Mine', false));
});

// ============================================================================
// A save merged with a change made elsewhere (`files.merge`)
// ============================================================================

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Folder files over fresh in-memory storage, with the row at PATH set to `initial`. */
async function filesWith(initial: string | Uint8Array | undefined) {
	const { boundary } = await rawBrowserFolder({
		id: `merge.${crypto.randomUUID()}`,
	});
	const files = createFiles({ storage: boundary, definition });
	if (initial !== undefined) expectOk(await files.create(PATH, initial));
	const read = async () => {
		const { data, error } = await files.read(PATH);
		return error === null ? text(data.bytes) : undefined;
	};
	return { files, read };
}

test('a save that merges is written over the change made elsewhere', async () => {
	const { files, read } = await filesWith(row('Milk', true));
	const merged = expectOk(
		await files.merge(PATH, {
			base: row('Milk', false),
			ours: row('Mine', false),
		}),
	);
	expect(merged.kind).toBe('saved');
	expect(await read()).toBe(row('Mine', true));
});

test('held parts are written when resolved, and a further change elsewhere refuses the write', async () => {
	const { files, read } = await filesWith(row('Theirs', true));
	const held = expectOk(
		await files.merge(PATH, {
			base: row('Milk', false),
			ours: row('Mine', false),
		}),
	);
	if (held.kind !== 'held') throw new Error('Expected a held title');
	const [title] = held.conflicts;
	if (title === undefined) throw new Error('Expected a title conflict');
	const mine = { [title.id]: { kind: 'take', side: 'local' } };

	const changed = expectOk(await files.read(PATH));
	expectOk(await files.replace(changed, row('Again', true)));
	expect(expectErr(await held.resolve(mine)).name).toBe('Conflict');
	expect(await read()).toBe(row('Again', true));

	const again = expectOk(
		await files.merge(PATH, {
			base: row('Milk', false),
			ours: row('Mine', false),
		}),
	);
	if (again.kind !== 'held') throw new Error('Expected a held title');
	expectOk(
		await again.resolve({ [title.id]: { kind: 'take', side: 'local' } }),
	);
	expect(await read()).toBe(row('Mine', true));
});

test('a file deleted elsewhere is held whole; restoring it is refused when the caller says so', async () => {
	const { files, read } = await filesWith(undefined);
	const held = expectOk(
		await files.merge(
			PATH,
			{ base: row('Milk', false), ours: row('Mine', false) },
			{ restore: false },
		),
	);
	if (held.kind !== 'held') throw new Error('Expected a held file');
	const [file] = held.conflicts;
	if (file === undefined) throw new Error('Expected a file conflict');

	const refused = expectErr(
		await held.resolve({ [file.id]: { kind: 'take', side: 'local' } }),
	);
	expect(refused.name).toBe('InvalidChoices');
	expect(await read()).toBeUndefined();
	expect(
		expectOk(
			await held.resolve({ [file.id]: { kind: 'take', side: 'incoming' } }),
		),
	).toBeUndefined();
	expect(await read()).toBeUndefined();
});

test('a file that is no longer text is held whole: their bytes stay, or the draft replaces them', async () => {
	const bytes = new Uint8Array([0xff, 0x00, 0xfe]);
	const { files, read } = await filesWith(bytes);
	const held = expectOk(
		await files.merge(PATH, {
			base: row('Milk', false),
			ours: row('Mine', false),
		}),
	);
	if (held.kind !== 'held') throw new Error('Expected a held file');
	const [file] = held.conflicts;
	if (file === undefined) throw new Error('Expected a file conflict');
	expect(file.incoming).toEqual({ present: true, value: bytes });

	expectOk(
		await held.resolve({ [file.id]: { kind: 'take', side: 'incoming' } }),
	);
	expect(expectOk(await files.read(PATH)).bytes).toEqual(bytes);
	expectOk(await held.resolve({ [file.id]: { kind: 'take', side: 'local' } }));
	expect(await read()).toBe(row('Mine', false));
});

test('an answer that is their version leaves their bytes as they wrote them', async () => {
	const theirs = '---\ntitle: Theirs\ndone: true\n---\n';
	const { files, read } = await filesWith(theirs);
	const held = expectOk(
		await files.merge(PATH, {
			base: row('Milk', false),
			ours: row('Mine', false),
		}),
	);
	if (held.kind !== 'held') throw new Error('Expected a held title');
	const [title] = held.conflicts;
	if (title === undefined) throw new Error('Expected a title conflict');

	const before = expectOk(await files.read(PATH)).sha256;
	expect(
		expectOk(
			await held.resolve({ [title.id]: { kind: 'take', side: 'incoming' } }),
		)?.sha256,
	).toBe(before);
	expect(await read()).toBe(theirs);
});
