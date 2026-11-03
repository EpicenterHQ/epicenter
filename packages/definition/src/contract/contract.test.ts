/**
 * Contract Compilation Tests
 *
 * `compileContract` is the one run-time check of a contract, whether it was
 * written in code or read from published JSON. A gap here lets two
 * collections claim one file, or a field schema validate differently in
 * code than in a file.
 *
 * Key behaviors:
 * - A note path is claimed only by a note collection, any other path only by a file collection
 * - Collections of one kind that could name the same file are refused
 * - A contract's name comes from its site; `$schema` and `description` are allowed
 * - Names a value reserves, placeholder and field collisions, and unknown keys are refused
 * - Field schemas follow the same portability rules as table fields
 * - `checkFields` reads `required` as JSON Schema does; `pathOf` never lets a file collection name a note
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { compileContract, defineContract } from './contract.js';

test('a collection cannot claim the root AGENTS.md note', () => {
	const error = expectErr(
		compileContract({
			collections: { notes: { path: '{id}.md' } },
		}),
	);
	expect(error.reason).toContain('AGENTS.md');
});

const recorder = defineContract({
	collections: {
		recordings: {
			path: 'recordings/{id}.md',
			fields: {
				title: { type: 'string' },
				durationMs: { type: 'number', minimum: 0 },
				tags: { type: 'array', items: { type: 'string' } },
			},
			required: ['title'],
		},
		audio: { path: 'recordings/{id}.{ext}' },
		settings: { path: 'settings.md' },
	},
});

test('a note path is claimed by its note collection, and {id}.{ext} never claims it', () => {
	const compiled = expectOk(compileContract(recorder));
	const note = compiled.claim('recordings/abc.md');
	expect(note?.collection.name).toBe('recordings');
	expect(note?.params).toEqual({ id: 'abc' });
	const audio = compiled.claim('recordings/abc.webm');
	expect(audio?.collection.name).toBe('audio');
	expect(audio?.params).toEqual({ id: 'abc', ext: 'webm' });
	expect(compiled.claim('settings.md')?.collection.name).toBe('settings');
	expect(compiled.claim('other/abc.md')).toBeNull();
});

test('a published contract compiles as the code one does', () => {
	const fromJson = expectOk(
		compileContract(JSON.parse(JSON.stringify(recorder))),
	);
	expect(fromJson.collections.map((c) => [c.name, c.kind, c.keys])).toEqual([
		['recordings', 'note', ['title', 'durationMs', 'tags']],
		['audio', 'file', []],
		['settings', 'note', []],
	]);
});

test('a contract has no name, and $schema and description may sit beside collections', () => {
	const described = defineContract({
		$schema: 'https://epicenter.so/schemas/contract.json',
		description: 'Recordings and their transcripts.',
		collections: { recordings: { path: 'recordings/{id}.md' } },
	});
	expectOk(compileContract(described));
	const error = expectErr(
		compileContract({
			name: 'whispering',
			collections: { recordings: { path: 'recordings/{id}.md' } },
		}),
	);
	expect(error.reason).toContain("'name'");
	expect(error.reason).toContain('name comes from its site');
});

test('two collections of one kind that can name the same file are refused', () => {
	const error = expectErr(
		compileContract({
			collections: {
				notes: { path: 'notes/{id}.md' },
				index: { path: 'notes/index.md' },
			},
		}),
	);
	expect(error.reason).toContain("'notes'");
	expect(error.reason).toContain("'index'");
});

test('malformed contracts are refused with a reason', () => {
	const malformed: unknown[] = [
		null,
		[],
		{},
		{ collections: {} },
		{ collections: { a: { path: 'a.md' } }, kind: 'note' },
		{ $schema: 1, collections: { a: { path: 'a.md' } } },
		{ description: ['x'], collections: { a: { path: 'a.md' } } },
		{ collections: { 'bad-name': { path: 'a.md' } } },
		{ collections: { a: { path: 'a.md', id: 'id' } } },
		{ collections: { a: { path: '../a.md' } } },
		{ collections: { a: { path: 'a/{body}.md' } } },
		{ collections: { a: { path: 'a/{version}.{ext}' } } },
		{
			collections: {
				a: { path: 'a/{id}.md', fields: { body: { type: 'string' } } },
			},
		},
		{
			collections: {
				a: { path: 'a/{id}.md', fields: { id: { type: 'string' } } },
			},
		},
		{
			collections: {
				a: { path: 'a/{id}.webm', fields: { t: { type: 'string' } } },
			},
		},
		{ collections: { a: { path: 'a/{id}.webm', required: [] } } },
		{
			collections: { a: { path: 'a/{id}.md', fields: { t: 'string' } } },
		},
		{
			collections: {
				a: {
					path: 'a/{id}.md',
					fields: { t: { type: 'string', format: 'phone' } },
				},
			},
		},
		{
			collections: {
				a: { path: 'a/{id}.md', fields: { t: { $ref: '#/nowhere' } } },
			},
		},
		{
			collections: {
				a: {
					path: 'a/{id}.md',
					fields: { t: { type: 'string' } },
					required: ['u'],
				},
			},
		},
	];
	for (const contract of malformed)
		expect(expectErr(compileContract(contract)).name).toBe('Malformed');
});

test('checkFields: required fields must be present, others may be absent, undeclared keys pass', () => {
	const recordings = expectOk(compileContract(recorder)).collections[0];
	expect(recordings?.checkFields({ title: 'x' })).toEqual([]);
	expect(recordings?.checkFields({ title: 'x', unknown: { any: 1 } })).toEqual(
		[],
	);
	expect(recordings?.checkFields({})).toEqual([
		{ field: 'title', message: 'title is missing' },
	]);
	const issues = recordings?.checkFields({
		title: 1,
		durationMs: -1,
		tags: ['a', 2],
	});
	expect(issues?.map((issue) => issue.field)).toEqual([
		'title',
		'durationMs',
		'tags',
	]);
	expect(issues?.find((issue) => issue.field === 'tags')?.path).toBe('/1');
});

test('pathOf fills a file path, and refuses an extension that would name a note', () => {
	const audio = expectOk(compileContract(recorder)).collections[1];
	expect(expectOk(audio!.pathOf({ id: 'a', ext: 'webm' }))).toBe(
		'recordings/a.webm',
	);
	expect(expectErr(audio!.pathOf({ id: 'a', ext: 'md' })).name).toBe(
		'InvalidValue',
	);
	// `.MD` names a note too: a Mac checkout reads it as one.
	expect(expectErr(audio!.pathOf({ id: 'a', ext: 'MD' })).name).toBe(
		'InvalidValue',
	);
});
