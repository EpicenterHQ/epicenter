/**
 * Path Template Tests
 *
 * Templates are how a contract names files. These tests pin matching, filling
 * and overlap detection, because an overlap missed here lets two collections
 * claim one file, and a value that escapes its segment writes outside the
 * template.
 *
 * Key behaviors:
 * - A placeholder never spans `/`, never matches a hidden name, and round-trips
 * - Several placeholders share a segment (`{id}.{ext}`) and still round-trip
 * - Bad templates and escaping values are refused as Results
 * - `templatesOverlap` never misses a real overlap (checked against witnesses)
 *
 * Ported from `claude/repository-v2` `core/templates.test.ts`, with cases for
 * several placeholders per segment and literal prefixes added.
 */
import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	compileTemplate,
	fill,
	isNoteTemplate,
	match,
	type Template,
	templatesOverlap,
} from './templates.js';

const compile = (source: string): Template => expectOk(compileTemplate(source));

describe('match and fill', () => {
	const tasks = compile('projects/{project}/tasks/{stem}.md');

	test('match extracts named segments', () => {
		expect(match(tasks, 'projects/acme/tasks/fix-login.md')).toEqual({
			project: 'acme',
			stem: 'fix-login',
		});
	});

	test('a placeholder never spans a slash', () => {
		expect(match(tasks, 'projects/acme/x/tasks/fix.md')).toBeNull();
	});

	test('the suffix must match and the value must be non-empty', () => {
		expect(match(tasks, 'projects/acme/tasks/fix.txt')).toBeNull();
		expect(match(tasks, 'projects/acme/tasks/.md')).toBeNull();
	});

	test('hidden files never match', () => {
		expect(match(compile('notes/{stem}.md'), 'notes/.draft.md')).toBeNull();
	});

	test('a value may contain dots and spaces', () => {
		expect(match(compile('notes/{stem}.md'), 'notes/v1.2 plan.md')).toEqual({
			stem: 'v1.2 plan',
		});
	});

	test('a template without placeholders matches exactly one file', () => {
		const settings = compile('settings.md');
		expect(settings.params).toEqual([]);
		expect(match(settings, 'settings.md')).toEqual({});
		expect(match(settings, 'other.md')).toBeNull();
	});

	test('fill round-trips with match', () => {
		const path = expectOk(fill(tasks, { project: 'acme', stem: 'fix-login' }));
		expect(path).toBe('projects/acme/tasks/fix-login.md');
		expect(match(tasks, path)).toEqual({ project: 'acme', stem: 'fix-login' });
	});

	test('fill refuses values that would escape or hide their segment', () => {
		for (const bad of ['a/b', '', '.hidden', '..', 'a\\b', 'a\nb', 'a\0b']) {
			const error = expectErr(fill(tasks, { project: bad, stem: 'x' }));
			expect(error.name).toBe('InvalidValue');
		}
		expect(expectErr(fill(tasks, { project: 'acme' })).name).toBe(
			'InvalidValue',
		);
	});

	test('bad templates are refused', () => {
		for (const bad of [
			'',
			'/notes/{stem}.md',
			'notes//{stem}.md',
			'notes/{a}{b}.md',
			'notes/{stem}.md/',
			'{x}/{x}.md',
			'{id}.{id}',
			'.hidden/{stem}.md',
			'notes/.{stem}.md',
			'notes/{my-stem}.md',
			'notes/{1st}.md',
			'notes/{}.md',
			'notes/{stem.md',
			'notes/stem}.md',
			'../{stem}.md',
		])
			expect(expectErr(compileTemplate(bad)).name).toBe('Invalid');
	});

	test('a literal prefix is part of the segment', () => {
		const days = compile('journal/day-{date}.md');
		expect(match(days, 'journal/day-2026-10-30.md')).toEqual({
			date: '2026-10-30',
		});
		expect(match(days, 'journal/2026-10-30.md')).toBeNull();
	});
});

describe('several placeholders in one segment', () => {
	const audio = compile('recordings/{id}.{ext}');

	test('{id}.{ext} splits at the first dot', () => {
		expect(match(audio, 'recordings/abc.webm')).toEqual({
			id: 'abc',
			ext: 'webm',
		});
		expect(match(audio, 'recordings/abc.tar.gz')).toEqual({
			id: 'abc',
			ext: 'tar.gz',
		});
		expect(match(audio, 'recordings/abc')).toBeNull();
		expect(match(audio, 'recordings/abc.')).toBeNull();
		expect(match(audio, 'recordings/.webm')).toBeNull();
	});

	test('fill refuses a leading value holding the separator, which match could not read back', () => {
		expect(expectErr(fill(audio, { id: 'a.b', ext: 'webm' })).name).toBe(
			'InvalidValue',
		);
		expect(expectOk(fill(audio, { id: 'a', ext: 'tar.gz' }))).toBe(
			'recordings/a.tar.gz',
		);
	});

	test('fill and match are inverses over values that hold separators', () => {
		const templates = [
			audio,
			compile('{a}-{b}.md'),
			compile('x{a}aa{b}y'),
			compile('{a}--{b}--{c}'),
		];
		const pieces = ['a', 'b', '-', '.', 'aa', 'x', 'y', '--', 'webm'];
		let state = 0x2545f491;
		const next = () => {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			return (state >>> 0) / 2 ** 32;
		};
		const value = () =>
			Array.from(
				{ length: 1 + Math.floor(next() * 4) },
				() => pieces[Math.floor(next() * pieces.length)],
			).join('');
		for (let k = 0; k < 5_000; k++)
			for (const template of templates) {
				const params = Object.fromEntries(
					template.params.map((param) => [param, value()]),
				);
				const filled = fill(template, params);
				if (filled.error !== null) continue;
				expect(match(template, filled.data)).toEqual(params);
			}
	});

	test('a note template ends in .md; {id}.{ext} names files', () => {
		expect(isNoteTemplate(compile('recordings/{id}.md'))).toBe(true);
		expect(isNoteTemplate(compile('settings.md'))).toBe(true);
		expect(isNoteTemplate(audio)).toBe(false);
		expect(isNoteTemplate(compile('photos/{name}'))).toBe(false);
	});
});

describe('overlap detection', () => {
	const overlap = (a: string, b: string) =>
		templatesOverlap(compile(a), compile(b));

	test('disjoint folders do not overlap', () => {
		expect(overlap('notes/{stem}.md', 'todos/{stem}.md')).toBe(false);
	});
	test('different depths do not overlap', () => {
		expect(overlap('notes/{stem}.md', 'notes/{stem}/index.md')).toBe(false);
	});
	test('different suffixes do not overlap', () => {
		expect(overlap('recordings/{stem}.md', 'recordings/{stem}.m4a')).toBe(
			false,
		);
	});
	test('a placeholder folder overlaps a literal folder', () => {
		expect(overlap('{space}/notes/{stem}.md', 'work/notes/{stem}.md')).toBe(
			true,
		);
	});
	test('{file} overlaps {stem}.md in the same folder', () => {
		expect(overlap('notes/{stem}/{file}', 'notes/{stem}/{name}.md')).toBe(true);
	});
	test('a literal file overlaps a matching placeholder file', () => {
		expect(overlap('notes/{stem}.md', 'notes/index.md')).toBe(true);
	});
	test('a literal a placeholder cannot produce does not overlap it', () => {
		expect(overlap('notes/{stem}.md', 'notes/md')).toBe(false);
	});
	test('{id}.{ext} overlaps {id}.md: the kind of a path, not its template, keeps them apart', () => {
		expect(overlap('recordings/{id}.{ext}', 'recordings/{id}.md')).toBe(true);
	});
	test('different prefixes do not overlap', () => {
		expect(overlap('j/day-{d}.md', 'j/week-{d}.md')).toBe(false);
	});

	test('overlap agrees with brute force over witness paths', () => {
		const pool = [
			'notes/{stem}.md',
			'notes/{stem}/{file}',
			'notes/{stem}/{name}.md',
			'{space}/notes/{stem}.md',
			'work/notes/{stem}.md',
			'notes/index.md',
			'notes/pre-{x}.md',
			'recordings/{stem}.m4a',
			'recordings/{id}.{ext}',
			'{a}/{b}',
			'{a}/{b}.{c}',
			'settings.md',
			'{x}.md',
			'{x}',
		];
		const paths = [
			'notes/a.md',
			'notes/pre-a.md',
			'notes/index.md',
			'notes/a/b.md',
			'notes/a/b.jpg',
			'work/notes/a.md',
			'home/notes/a.md',
			'recordings/a.m4a',
			'recordings/a.md',
			'recordings/a.b.webm',
			'settings.md',
			'x.md',
			'x',
			'a/b',
			'a/b.md',
		];
		for (const a of pool)
			for (const b of pool) {
				if (a === b) continue;
				const witness = paths.some(
					(path) =>
						match(compile(a), path) !== null &&
						match(compile(b), path) !== null,
				);
				// A real overlap is never missed; symmetric either way.
				if (witness) expect(overlap(a, b)).toBe(true);
				expect(overlap(a, b)).toBe(overlap(b, a));
			}
	});
});
