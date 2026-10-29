/**
 * Path Template Tests
 *
 * Templates are how an app names files. These tests pin matching, building and
 * overlap detection, because an overlap missed here lets two handles claim one
 * file, and a value that escapes its segment writes outside the template.
 *
 * Key behaviors:
 * - A parameter never spans `/`, never matches a hidden name, and round-trips
 * - Bad templates and escaping values are refused as Results
 * - `templatesOverlap` never misses a real overlap (checked against witnesses)
 */
import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	buildPath,
	compileTemplate,
	matchTemplate,
	type Template,
	templatesOverlap,
} from './templates.js';

const compile = (source: string): Template => expectOk(compileTemplate(source));

describe('match and build', () => {
	const tasks = compile('projects/{project}/tasks/{stem}.md');

	test('match extracts named segments', () => {
		expect(matchTemplate(tasks, 'projects/acme/tasks/fix-login.md')).toEqual({
			project: 'acme',
			stem: 'fix-login',
		});
	});

	test('a parameter never spans a slash', () => {
		expect(matchTemplate(tasks, 'projects/acme/x/tasks/fix.md')).toBeNull();
	});

	test('the suffix must match and the value must be non-empty', () => {
		expect(matchTemplate(tasks, 'projects/acme/tasks/fix.txt')).toBeNull();
		expect(matchTemplate(tasks, 'projects/acme/tasks/.md')).toBeNull();
	});

	test('hidden files never match', () => {
		expect(matchTemplate(compile('notes/{stem}.md'), 'notes/.draft.md')).toBeNull();
	});

	test('a value may contain dots and spaces', () => {
		expect(matchTemplate(compile('notes/{stem}.md'), 'notes/v1.2 plan.md')).toEqual(
			{ stem: 'v1.2 plan' },
		);
	});

	test('a template without parameters matches exactly one file', () => {
		const settings = compile('settings.md');
		expect(settings.params).toEqual([]);
		expect(matchTemplate(settings, 'settings.md')).toEqual({});
		expect(matchTemplate(settings, 'other.md')).toBeNull();
	});

	test('build round-trips with match', () => {
		const path = expectOk(buildPath(tasks, { project: 'acme', stem: 'fix-login' }));
		expect(path).toBe('projects/acme/tasks/fix-login.md');
		expect(matchTemplate(tasks, path)).toEqual({ project: 'acme', stem: 'fix-login' });
	});

	test('build refuses values that would escape or hide their segment', () => {
		for (const bad of ['a/b', '', '.hidden', '..', 'a\\b', 'a\nb', 'a\0b']) {
			const error = expectErr(buildPath(tasks, { project: bad, stem: 'x' }));
			expect(error.name).toBe('InvalidValue');
		}
		expect(expectErr(buildPath(tasks, { project: 'acme' })).name).toBe('InvalidValue');
	});

	test('bad templates are refused', () => {
		for (const bad of [
			'',
			'/notes/{stem}.md',
			'notes//{stem}.md',
			'notes/{a}{b}.md',
			'notes/{stem}.md/',
			'{x}/{x}.md',
			'.hidden/{stem}.md',
			'notes/pre{stem}.md',
			'notes/{my-stem}.md',
			'notes/{1st}.md',
			'../{stem}.md',
		])
			expect(expectErr(compileTemplate(bad)).name).toBe('Invalid');
	});
});

describe('overlap detection', () => {
	const overlap = (a: string, b: string) => templatesOverlap(compile(a), compile(b));

	test('disjoint folders do not overlap', () => {
		expect(overlap('notes/{stem}.md', 'todos/{stem}.md')).toBe(false);
	});
	test('different depths do not overlap', () => {
		expect(overlap('notes/{stem}.md', 'notes/{stem}/index.md')).toBe(false);
	});
	test('different suffixes do not overlap', () => {
		expect(overlap('recordings/{stem}.md', 'recordings/{stem}.m4a')).toBe(false);
	});
	test('a parameter folder overlaps a literal folder', () => {
		expect(overlap('{space}/notes/{stem}.md', 'work/notes/{stem}.md')).toBe(true);
	});
	test('{file} overlaps {stem}.md in the same folder', () => {
		expect(overlap('notes/{stem}/{file}', 'notes/{stem}/{name}.md')).toBe(true);
	});
	test('a literal file overlaps a matching parameter file', () => {
		expect(overlap('notes/{stem}.md', 'notes/index.md')).toBe(true);
	});
	test('a literal a parameter cannot produce does not overlap it', () => {
		expect(overlap('notes/{stem}.md', 'notes/md')).toBe(false);
	});

	test('overlap agrees with brute force over witness paths', () => {
		const pool = [
			'notes/{stem}.md',
			'notes/{stem}/{file}',
			'notes/{stem}/{name}.md',
			'{space}/notes/{stem}.md',
			'work/notes/{stem}.md',
			'notes/index.md',
			'recordings/{stem}.m4a',
			'{a}/{b}',
			'settings.md',
			'{x}.md',
			'{x}',
		];
		const paths = [
			'notes/a.md',
			'notes/index.md',
			'notes/a/b.md',
			'notes/a/b.jpg',
			'work/notes/a.md',
			'home/notes/a.md',
			'recordings/a.m4a',
			'recordings/a.md',
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
						matchTemplate(compile(a), path) !== null &&
						matchTemplate(compile(b), path) !== null,
				);
				// A real overlap is never missed; symmetric either way.
				if (witness) expect(overlap(a, b)).toBe(true);
				expect(overlap(a, b)).toBe(overlap(b, a));
			}
	});
});
