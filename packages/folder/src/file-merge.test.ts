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
 */
import { expect, test } from 'bun:test';
import type { Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	defineFolder,
	defineTable,
	field,
	type SyncError,
} from './contract.js';
import { prepareFolderDefinition } from './definition.js';
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
