import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { SavedView, SavedViewChange } from '@epicenter/folder/declaration';
import { Ok } from 'wellcrafted/result';
import type { QueryAnswer } from '../ui/bindings.gen';

const { createViews, SQL } = await import('./views.svelte');
const grid: SavedView = { type: 'grid', title: 'Tasks', table: 'tasks' };

test('clean views follow file edits; dirty settings retain their captured base across save and refresh', async () => {
	const disk: Record<string, SavedView> = { a: grid };
	let finish!: () => void;
	let submitted!: SavedViewChange;
	const views = createViews({
		saved: () => disk,
		exclusive: (action) => action(),
		refreshed: async () => {},
		update: async (change) => {
			submitted = change;
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			disk[change.key] = change.value!;
			return Ok({ written: true });
		},
	});
	expect(views.value('saved:a')).toEqual(grid);
	disk.a = { ...grid, title: 'Changed elsewhere' };
	expect(views.value('saved:a')?.title).toBe('Changed elsewhere');
	views.edit('saved:a', { ...grid, title: 'Mine' });
	const saving = views.save('saved:a');
	views.edit('saved:a', { ...grid, title: 'New typing' });
	finish();
	await saving;
	expect(views.value('saved:a')?.title).toBe('New typing');
	expect(views.dirty('saved:a')).toBe(true);
	const second = views.save('saved:a');
	expect(submitted.base).toEqual({ ...grid, title: 'Mine' });
	finish();
	await second;
	expect(views.dirty('saved:a')).toBe(false);
	expect(views.value('saved:a')?.title).toBe('New typing');
});

test('failed explicit save keeps copyable input and blocks close until dismissal or retry', async () => {
	const views = createViews({
		saved: () => ({ a: grid }),
		exclusive: (action) => action(),
		refreshed: async () => {},
		update: async () => ({
			data: null,
			error: { reason: 'changed elsewhere' },
		}),
	});
	views.edit('saved:a', { ...grid, title: 'Keep me' });
	await views.save('saved:a');
	expect(views.failed).toBe(true);
	expect(views.error('saved:a')).toBe('changed elsewhere');
	views.dismiss('saved:a');
	expect(views.failed).toBe(false);
	expect(views.value('saved:a')?.title).toBe('Keep me');
});

test('SQL completion belongs to its submitted key and statement, preserving later typing', async () => {
	const disk: Record<string, SavedView> = {
		a: { type: 'sql', title: 'A', sql: 'select 1' },
		b: { type: 'sql', title: 'B', sql: 'select 2' },
	};
	const views = createViews({
		saved: () => disk,
		update: async () => Ok({ written: true }),
		exclusive: (action) => action(),
		refreshed: async () => {},
	});
	let finish!: (result: { data: QueryAnswer; error: null }) => void;
	const running = views.run(
		'saved:a',
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	views.edit('saved:a', { type: 'sql', title: 'A', sql: 'select 3' });
	views.edit(SQL, { type: 'sql', title: 'Scratch', sql: 'select 4' });
	finish({
		data: {
			columns: ['n'],
			rows: [{ n: 1 }],
			warnings: [],
			excluded: [],
			truncated: false,
		},
		error: null,
	});
	await running;
	expect(views.execution('saved:a')?.sql).toBe('select 1');
	expect(views.execution('saved:b')).toBeUndefined();
	expect(views.value('saved:a')).toMatchObject({ sql: 'select 3' });
	expect(views.value(SQL)).toMatchObject({ sql: 'select 4' });
});

test('retry after a confirmed create and failed refresh reuses its target and submitted base', async () => {
	const disk: Record<string, SavedView> = {};
	const changes: SavedViewChange[] = [];
	let failRefresh = true;
	const views = createViews({
		saved: () => disk,
		exclusive: (action) => action(),
		update: async (change) => {
			changes.push(change);
			disk[change.key] = change.value!;
			return Ok({ written: true });
		},
		refreshed: async () => {
			if (failRefresh) throw new Error('cannot reread');
		},
	});
	views.edit(SQL, { type: 'sql', title: 'Query', sql: 'select 1' });
	const target = await views.save(SQL);
	expect(views.failed).toBe(false);
	expect(views.notice(target)).toContain('view was saved');
	views.edit(target, { type: 'sql', title: 'Query', sql: 'select 2' });
	failRefresh = false;
	await views.save(target);
	expect(changes[1]?.key).toBe(changes[0]?.key);
	expect(changes[1]?.base).toMatchObject({ sql: 'select 1' });
	expect(Object.keys(disk)).toHaveLength(1);
	expect(views.failed).toBe(false);
});

test('delete captures what was displayed and retains typing entered during the source drain', async () => {
	const disk: Record<string, SavedView> = { a: grid };
	let begin!: () => void;
	let submitted!: SavedViewChange;
	const views = createViews({
		saved: () => disk,
		exclusive: async (action) => {
			await new Promise<void>((resolve) => {
				begin = resolve;
			});
			return action();
		},
		update: async (change) => {
			submitted = change;
			delete disk[change.key];
			return Ok({ written: true });
		},
		refreshed: async () => {},
	});
	const removing = views.remove('saved:a');
	disk.a = { ...grid, title: 'Unseen' };
	views.edit('saved:a', { ...grid, title: 'Keep typing' });
	begin();
	await removing;
	expect(submitted.base).toEqual(grid);
	expect(views.value('saved:a')?.title).toBe('Keep typing');
	expect(views.dirty('saved:a')).toBe(true);
});

test('authored keys cannot collide with scratch or Files navigation', () => {
	const disk = { files: grid, 'scratch:tables': { ...grid, title: 'Other' } };
	const views = createViews({
		saved: () => disk,
		exclusive: (action) => action(),
		update: async () => Ok({ written: true }),
		refreshed: async () => {},
	});
	expect(views.value('saved:files')).toEqual(grid);
	expect(views.value('saved:scratch:tables')?.title).toBe('Other');
	expect(views.value('scratch:tables')?.title).toBe('Tables');
});

test('Save as new after a failed update copies settings and leaves the original unchanged', async () => {
	const disk: Record<string, SavedView> = { a: grid };
	let fail = true;
	const views = createViews({
		saved: () => disk,
		exclusive: (action) => action(),
		refreshed: async () => {},
		update: async (change) => {
			if (fail) return { error: { reason: 'conflict' } };
			disk[change.key] = change.value!;
			return Ok({ written: true });
		},
	});
	views.edit('saved:a', { ...grid, title: 'Copy' });
	await views.save('saved:a');
	fail = false;
	const copied = await views.save('saved:a', true);
	expect(copied).not.toBe('saved:a');
	expect(disk.a).toEqual(grid);
	expect(views.value(copied)?.title).toBe('Copy');
	expect(views.failed).toBe(false);
});

for (const source of ['saved:a', SQL])
	test(`typing during a copy from ${source} follows the new key and its next Save`, async () => {
		const disk: Record<string, SavedView> = { a: grid };
		let finish!: () => void;
		const views = createViews({
			saved: () => disk,
			exclusive: (action) => action(),
			refreshed: async () => {},
			update: async (change) => {
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				disk[change.key] = change.value!;
				return Ok({ written: true });
			},
		});
		const recipe = views.value(source)!;
		const saving = views.save(source, true);
		views.edit(source, { ...recipe, title: 'Later typing' });
		finish();
		const target = await saving;
		expect(target).not.toBe(source);
		expect(views.value(target)?.title).toBe('Later typing');
		expect(views.dirty(target)).toBe(true);
		const second = views.save(target);
		finish();
		await second;
		expect(Object.keys(disk)).toHaveLength(2);
		expect(disk.a).toEqual(grid);
		expect(views.value(target)?.title).toBe('Later typing');
		expect(views.dirty(target)).toBe(false);
	});

test('retained orphan settings stay enumerable after external deletion and while visiting Files', async () => {
	const disk: Record<string, SavedView> = { a: grid };
	const views = createViews({
		saved: () => disk,
		exclusive: (action) => action(),
		refreshed: async () => {},
		update: async () => ({ error: { reason: 'deleted elsewhere' } }),
	});
	views.edit('saved:a', { ...grid, title: 'Keep this' });
	delete disk.a;
	await views.save('saved:a');
	expect(views.held).toEqual([['saved:a', { ...grid, title: 'Keep this' }]]);
	views.dismiss('saved:a');
	expect(views.held).toHaveLength(1);
});

test('a confirmed copy with failed reread stays owned by its target when the primary Save is used', async () => {
	const disk: Record<string, SavedView> = { a: grid };
	let failRefresh = true;
	const views = createViews({
		saved: () => disk,
		exclusive: (action) => action(),
		update: async (change) => {
			disk[change.key] = change.value!;
			return Ok({ written: true });
		},
		refreshed: async () => {
			if (failRefresh) throw new Error('offline');
		},
	});
	views.edit('saved:a', { ...grid, title: 'Copy' });
	const target = await views.save('saved:a', true);
	expect(target).not.toBe('saved:a');
	expect(views.failed).toBe(false);
	expect(views.notice(target)).toContain('view was saved');
	views.edit(target, { ...grid, title: 'Later copy edits' });
	failRefresh = false;
	await views.save(target);
	expect(disk.a).toEqual(grid);
	expect(Object.keys(disk)).toHaveLength(2);
	expect(views.value(target)?.title).toBe('Later copy edits');
});

test('the primary Retry keeps an unconfirmed copy aimed at its original new target', async () => {
	const disk: Record<string, SavedView> = { a: grid };
	let fail = true;
	const changes: SavedViewChange[] = [];
	const views = createViews({
		saved: () => disk,
		exclusive: (action) => action(),
		refreshed: async () => {},
		update: async (change) => {
			changes.push(change);
			if (fail) return { error: { reason: 'unconfirmed' } };
			disk[change.key] = change.value!;
			return Ok({ written: true });
		},
	});
	views.edit('saved:a', { ...grid, title: 'Copy' });
	await views.save('saved:a', true);
	fail = false;
	await views.save('saved:a');
	expect(changes[1]?.key).toBe(changes[0]?.key);
	expect(disk.a).toEqual(grid);
});
