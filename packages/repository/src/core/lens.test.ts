/**
 * defineApp Tests
 *
 * An app definition is the lens a device opens. These tests check that bad
 * apps are refused when defined, that paths classify to at most one handle,
 * and that each generated view, run in real SQLite, selects exactly the files
 * its template names with typed parameter and field columns.
 *
 * Key behaviors:
 * - Bad names, reserved names, bad templates, kind mismatches and overlaps throw
 * - A Markdown path classifies only to note templates
 * - Views extract parameters and fields and skip hidden, nested and deleted files
 * - `app.check` reports parsing and, for a note name, schema issues, without a repository
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { defineApp, timestamp } from './lens.js';

const Task = Type.Object({ title: Type.String(), done: Type.Boolean() });

function sampleApp() {
	return defineApp({
		tasks: { path: 'projects/{project}/tasks/{stem}.md', schema: Task },
		settings: { path: 'settings.md', schema: Type.Object({ theme: Type.String() }) },
		photos: { path: 'projects/{project}/photos/{file}', blob: { types: ['image/png'] } },
	});
}

describe('refusals at definition time', () => {
	test('a name that is not an identifier is refused', () => {
		expect(() =>
			defineApp({ 'my-notes': { path: 'notes/{stem}.md', schema: Task } }),
		).toThrow(/identifier/);
	});

	test('a name the repository object uses is refused', () => {
		expect(() => defineApp({ batch: { path: 'notes/{stem}.md', schema: Task } })).toThrow(
			/reserved/,
		);
	});

	test('a bad template is refused', () => {
		expect(() => defineApp({ notes: { path: 'notes/{a}{b}.md', schema: Task } })).toThrow(
			/invalid/,
		);
	});

	test('a note template must end in .md and a blob template must not', () => {
		expect(() => defineApp({ notes: { path: 'notes/{stem}.txt', schema: Task } })).toThrow(
			/must end in .md/,
		);
		expect(() =>
			defineApp({ photos: { path: 'photos/{stem}.md', blob: { types: ['image/png'] } } }),
		).toThrow(/must not end in .md/);
	});

	test('overlapping templates are refused', () => {
		expect(() =>
			defineApp({
				notes: { path: '{space}/notes/{stem}.md', schema: Task },
				work: { path: 'work/notes/{stem}.md', schema: Task },
			}),
		).toThrow(/can match the same file/);
	});

	test('a field or parameter that collides with a column is refused', () => {
		expect(() =>
			defineApp({ notes: { path: 'notes/{stem}.md', schema: Type.Object({ stem: Type.String() }) } }),
		).toThrow(/collides/);
		expect(() => defineApp({ notes: { path: 'notes/{path}.md', schema: Task } })).toThrow(
			/collides/,
		);
	});
});

describe('classify', () => {
	test('each path belongs to at most one handle, and READMEs to none', () => {
		const app = sampleApp();
		expect(app.classify('projects/acme/tasks/fix.md')).toMatchObject({
			lens: { name: 'tasks' },
			params: { project: 'acme', stem: 'fix' },
		});
		expect(app.classify('projects/acme/photos/a.png')).toMatchObject({
			lens: { name: 'photos' },
			params: { file: 'a.png' },
		});
		expect(app.classify('settings.md')?.lens.name).toBe('settings');
		expect(app.classify('README.md')).toBeNull();
	});

	test('a broad blob template never claims a Markdown file', () => {
		expect(sampleApp().classify('projects/acme/photos/notes.md')).toBeNull();
	});

	test('gitattributes routes blob templates through LFS', () => {
		expect(sampleApp().gitattributes()).toBe(
			'projects/*/photos/* filter=lfs diff=lfs merge=lfs -text',
		);
	});
});

describe('views', () => {
	function setup() {
		const db = new Database(':memory:');
		db.exec(
			`CREATE TABLE "epicenter/files" (path TEXT PRIMARY KEY, text TEXT, fields TEXT, body TEXT)`,
		);
		const insert = db.prepare(
			`INSERT INTO "epicenter/files" (path, text, fields, body) VALUES (?, ?, ?, ?)`,
		);
		const row = (path: string, fields: object | null, body = '', text: string | null = 'x') =>
			insert.run(path, text, fields === null ? null : JSON.stringify(fields), body);
		row('projects/acme/tasks/fix login.md', { title: 'Fix', done: true }, 'Body');
		row('projects/acme/tasks/.hidden.md', { title: 'Hidden', done: false });
		row('projects/acme/x/tasks/deep.md', { title: 'Deep', done: false });
		row('projects/acme/tasks/gone.md', { title: 'Gone', done: false }, '', null);
		row('projects/a"b\\c/tasks/odd.md', { title: 'Odd', done: false });
		row('settings.md', { theme: 'dark' });
		row('projects/acme/photos/a.png', { oid: 'abc', size: 3 });
		for (const lens of sampleApp().lenses) db.exec(lens.view);
		return db;
	}

	test('a note view extracts parameters and fields and skips non-matching files', () => {
		const db = setup();
		expect(db.query('SELECT * FROM tasks ORDER BY path').all()).toEqual([
			{ path: 'projects/a"b\\c/tasks/odd.md', project: 'a"b\\c', stem: 'odd', title: 'Odd', done: 0, body: '' },
			{ path: 'projects/acme/tasks/fix login.md', project: 'acme', stem: 'fix login', title: 'Fix', done: 1, body: 'Body' },
		]);
	});

	test('a template without parameters is a one-row view', () => {
		expect(setup().query('SELECT theme FROM settings').all()).toEqual([{ theme: 'dark' }]);
	});

	test('a blob view exposes the pointer oid and size', () => {
		expect(setup().query('SELECT project, file, oid, size FROM photos').all()).toEqual([
			{ project: 'acme', file: 'a.png', oid: 'abc', size: 3 },
		]);
	});
});

test('app.check reports parsing, then the named schema', () => {
	const app = sampleApp();
	expect(app.check('---\ntitle: [\n---\n')).toMatchObject({ parses: false, line: 3 });
	expect(app.check('---\ntitle: A\ndone: false\n---\n')).toEqual({ parses: true, matches: null });
	expect(app.check('---\ntitle: A\ndone: false\n---\n', { as: 'tasks' })).toEqual({ parses: true, matches: true });
	expect(app.check('---\ntitle: A\n---\n', { as: 'tasks' })).toMatchObject({ parses: true, matches: false });
	// @ts-expect-error a blob name is not a note name
	app.check('', { as: 'photos' });
});

test('timestamp makes a sortable stem', () => {
	expect(timestamp(new Date('2026-10-28T12:00:00.123Z'))).toBe('2026-10-28T12-00-00Z');
});
