/**
 * Todos' one list: `oneList` (tested in `@epicenter/svelte`) with Todos'
 * order, over real device clients in temporary directories (a second one
 * stands in for the repository).
 *
 * Key behaviors:
 * - Open todos come first, then done ones, each oldest first, from either side
 *
 * Run with `--conditions=browser` (`bun run test`): `fromClient` needs
 * Svelte's client runtime.
 */
import '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDevice, outboxOf } from '@epicenter/folder/node';
import { todos } from './contract.js';

const { fromClient } = await import('@epicenter/svelte/client');
const { follow } = await import(
	'../../../../packages/svelte/src/reactive.test-support.svelte.js'
);
const { flushSync } = await import('svelte');
const { createTodoList } = await import('./todos.js');

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

/** A device client over a directory holding `files`. */
async function side(files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-todos-'));
	folders.push(root);
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), text);
	}
	return openDevice(todos, { path: root });
}

const note = (title: string, done = false) =>
	`---\ntitle: ${title}\ndone: ${done}\n---\n`;

test('open todos come first, then done ones, each oldest first, from either side', async () => {
	const device = await side({ 'todos/b.md': note('B') });
	const repository = await side({
		'todos/a.md': note('A', true),
		'todos/c.md': note('C'),
	});
	const list = createTodoList({
		device: fromClient(device).todos,
		repository: fromClient(repository).todos,
		outbox: outboxOf(device),
	});
	const rows = follow(() =>
		list.items.map(({ id, where }) => `${where}:${id}`),
	);
	for (let turn = 0; turn < 400 && list.loading; turn++) {
		await Bun.sleep(5);
		flushSync();
	}
	expect(rows.values.at(-1)).toEqual([
		'device:b',
		'repository:c',
		'repository:a',
	]);
	rows.stop();
});
