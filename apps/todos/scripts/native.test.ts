/** The native CLI reads and writes a directory of todos as the contract lays it out. */
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

const native = (directory: string, ...args: string[]) =>
	$`bun scripts/native.ts ${directory} ${args}`
		.cwd(join(import.meta.dir, '..'))
		.nothrow()
		.quiet();

async function directory() {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-todos-native-'));
	await mkdir(join(root, 'todos'));
	return root;
}

test('a todo written by hand completes, keeping the keys and notes Todos does not name', async () => {
	const root = await directory();
	try {
		await writeFile(
			join(root, 'todos/milk.md'),
			'---\ntitle: Milk\ndone: false\nowner: sam\n---\nOat, not dairy\n',
		);
		const completed = await native(root, 'complete', 'milk');
		expect(completed.json()).toEqual({ completed: 'milk' });
		expect(await readFile(join(root, 'todos/milk.md'), 'utf8')).toBe(
			'---\ntitle: Milk\ndone: true\nowner: sam\n---\nOat, not dairy\n',
		);

		const created = (await native(root, 'create', 'Buy bread')).json();
		const listed = (await native(root, 'list')).json();
		expect(listed).toEqual({
			todos: [
				{ id: created.created, title: 'Buy bread', done: false },
				{ id: 'milk', title: 'Milk', done: true },
			].sort((a, b) => (a.id < b.id ? -1 : 1)),
			invalid: [],
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('a note that does not fit is listed as invalid, and completing a missing todo writes nothing', async () => {
	const root = await directory();
	try {
		await writeFile(join(root, 'todos/broken.md'), '---\ntitle: [x\n---\n');
		const listed = (await native(root, 'list')).json();
		expect(listed.todos).toEqual([]);
		expect(listed.invalid.map(({ path }: { path: string }) => path)).toEqual([
			'todos/broken.md',
		]);

		const missing = await native(root, 'complete', 'missing');
		expect(missing.exitCode).toBe(1);
		expect(missing.json()).toEqual({ error: 'Nothing is at todos/missing.md' });
		expect(existsSync(join(root, 'todos/missing.md'))).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
