/** The Bun opener reads and saves ordinary files without Git. */
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFolder } from '@epicenter/folder/bun';
import { $ } from 'bun';
import { expectOk } from 'wellcrafted/testing';
import { todosTables } from '../src/lib/definition.js';

const native = (directory: string, ...args: string[]) =>
	$`bun scripts/native.ts ${directory} ${args}`.cwd(
		join(import.meta.dir, '..'),
	);

test('native Todos keeps existing source fields and survives process reopen without Git', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-todos-native-'));
	try {
		await mkdir(join(directory, 'todos'));
		await writeFile(
			join(directory, 'todos/milk.md'),
			'---\ntitle: Milk\ndone: false\nunknown: keep\n---\nA note\n',
		);
		const completed = await native(directory, 'complete', 'milk').json();
		expect(completed).toEqual({ updated: 'todos/milk.md' });
		const source = await readFile(join(directory, 'todos/milk.md'), 'utf8');
		expect(source).toContain('unknown: keep');
		expect(source).toContain('A note');
		const opened = expectOk(
			await openFolder({ directory, tables: todosTables }),
		);
		try {
			expect(opened.tables.todos.row('milk')?.fields?.done).toBe(true);
		} finally {
			await opened.close();
		}
		const created = await native(directory, 'create', 'Buy bread').json();
		expect(created.created).toMatch(/^todos\/.+\.md$/);
		const listed = await native(directory, 'list').json();
		expect(listed.todos).toHaveLength(2);
		expect(listed.invalid).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('complete missing exits with an error and creates no row', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-todos-native-'));
	try {
		const result = await native(directory, 'complete', 'missing').nothrow();
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.toString())).toEqual({
			error: 'There is no todo at todos/missing.md',
		});
		expect(existsSync(join(directory, 'todos/missing.md'))).toBe(false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
