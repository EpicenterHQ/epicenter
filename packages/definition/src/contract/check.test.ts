/**
 * Contract Check Tests
 *
 * `checkContract` is what `epicenter check` reports for a folder, so a miss
 * here is a broken file the person is never told about, and a false issue is
 * noise on every run.
 *
 * Key behaviors:
 * - Files that fit produce no issues; hidden paths are skipped
 * - A path no collection claims is an issue, by kind (a `.md` file never fits a file collection)
 * - Unparseable front matter and field failures are issues located by line and field
 * - A malformed contract is the error, not a file issue
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { checkContract } from './check.js';
import { defineContract } from './contract.js';

const recorder = defineContract({
	name: 'whispering',
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
	},
});

test('a folder that fits has no issues, and hidden paths are skipped', () => {
	expect(
		expectOk(
			checkContract(recorder, [
				{
					path: 'recordings/a.md',
					text: '---\ntitle: Standup\nmood: fine\n---\nBody\n',
				},
				{ path: 'recordings/a.webm' },
				{ path: 'recordings/b.md' },
				{ path: '.gitattributes' },
				{ path: '.obsidian/workspace.json' },
				{ path: 'recordings/.trash/x.md', text: 'not checked' },
			]),
		),
	).toEqual([]);
});

test('a path no collection claims is an issue, and a .md file never fits a file collection', () => {
	const issues = expectOk(
		checkContract(recorder, [
			{ path: 'notes/a.md', text: '---\ntitle: x\n---\n' },
			{ path: 'recordings/a/b.webm' },
			{ path: 'recordings/noext' },
		]),
	);
	expect(issues.map((issue) => issue.path)).toEqual([
		'notes/a.md',
		'recordings/a/b.webm',
		'recordings/noext',
	]);
	expect(issues[0]?.message).toContain('note');
	expect(issues[1]?.message).toContain('file');
});

test('front matter that does not parse is one issue at its line', () => {
	const [issue, ...rest] = expectOk(
		checkContract(recorder, [
			{ path: 'recordings/a.md', text: '---\ntitle: x\ntitle: y\n---\n' },
		]),
	);
	expect(rest).toEqual([]);
	expect(issue).toMatchObject({
		path: 'recordings/a.md',
		collection: 'recordings',
	});
	expect(issue?.line).toBeGreaterThanOrEqual(2);
});

test('field failures are issues by field, at the line of the value', () => {
	const issues = expectOk(
		checkContract(recorder, [
			{
				path: 'recordings/a.md',
				text: '---\ndurationMs: -5\ntags:\n  - ok\n  - 7\n---\n',
			},
		]),
	);
	expect(issues.map(({ field, line }) => [field, line])).toEqual([
		['title', undefined],
		['durationMs', 2],
		['tags', 5],
	]);
	expect(issues[0]?.message).toBe('title is missing');
});

test('a malformed contract is the error', () => {
	const error = expectErr(
		checkContract({ name: 'x', collections: { a: { path: '/a.md' } } }, []),
	);
	expect(error.name).toBe('Malformed');
});
