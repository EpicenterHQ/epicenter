import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	collisionKey,
	pathProblem,
	rowAddressProblem,
	rowStemOf,
	rowStemOfName,
	schemaPath,
	tableOfSchemaPath,
} from './paths.js';

/** The vectors `paths.rs` reads too, so the engine and the desktop shell agree. */
const rules = JSON.parse(
	readFileSync(
		join(
			import.meta.dir,
			'../../tauri-plugin-epicenter-folder/fixtures/path-rules.json',
		),
		'utf8',
	),
) as { refused: string[]; allowed: string[] };

describe('pathProblem follows the shared path rules', () => {
	test.each(rules.refused)('refuses %p', (path) => {
		expect(pathProblem(path)).toBeString();
	});
	test.each(rules.allowed)('allows %p', (path) => {
		expect(pathProblem(path)).toBeUndefined();
	});
});

test('names a case-insensitive disk holds as one fold to one key', () => {
	for (const [left, right] of [
		['Notes.md', 'notes.md'],
		['ΣΟΦΟΣ.md', 'σοφοσ.md'],
		['ς.md', 'σ.md'],
		['ß.md', 'ss.md'],
		['ﬀ.md', 'ff.md'],
		['ſ.md', 's.md'],
		['µm.md', 'μm.md'],
		['caf\u00e9.md', 'cafe\u0301.md'],
	])
		expect(collisionKey(left!)).toBe(collisionKey(right!));
	expect(collisionKey('a.md')).not.toBe(collisionKey('b.md'));
});

describe('the one row predicate', () => {
	test('a row file is a nonempty, non-dot id and exactly lowercase .md', () => {
		expect(rowStemOfName('a.md')).toBe('a');
		expect(rowStemOfName('a b.md')).toBe('a b');
		expect(rowStemOfName('a.b.md')).toBe('a.b');
		expect(rowStemOfName('notes.md.md')).toBe('notes.md');
		for (const name of [
			'.md',
			'.hidden.md',
			'..md',
			'.epicenter.json',
			'a.MD',
			'a.Md',
			'a.markdown',
			'a.md.txt',
			'a',
			'sub/a.md',
		])
			expect(rowStemOfName(name)).toBeUndefined();
	});

	test('a row is directly in its table directory', () => {
		expect(rowStemOf('todos', 'todos/a.md')).toBe('a');
		expect(rowStemOf('todos', 'todos/a/b.md')).toBeUndefined();
		expect(rowStemOf('todos', 'todos/.hidden.md')).toBeUndefined();
		expect(rowStemOf('todos', 'todos/.md')).toBeUndefined();
		expect(rowStemOf('todos', 'todos/A.MD')).toBeUndefined();
		expect(rowStemOf('todos', 'other/a.md')).toBeUndefined();
		expect(rowStemOf('todos', 'todosx/a.md')).toBeUndefined();
		expect(rowStemOf('todos', 'a.md')).toBeUndefined();
	});

	test('an address is refused exactly where the predicate would not read it back', () => {
		for (const stem of ['a', 'a b', 'a.b', 'a.md', 'ünïcode'])
			expect(rowAddressProblem('todos', stem)).toBeUndefined();
		for (const stem of ['', '.hidden', '.', '..', 'a/b', 'con'])
			expect(rowAddressProblem('todos', stem)).toBeString();
	});
});

test('a table schema is <table>/.epicenter.json, one level down', () => {
	expect(schemaPath('todos')).toBe('todos/.epicenter.json');
	expect(tableOfSchemaPath('todos/.epicenter.json')).toBe('todos');
	for (const path of [
		'.epicenter.json',
		'epicenter.json',
		'todos/epicenter.json',
		'a/b/.epicenter.json',
		'/.epicenter.json',
	])
		expect(tableOfSchemaPath(path)).toBeUndefined();
});
