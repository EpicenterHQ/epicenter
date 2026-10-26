import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { readSavedViews, type SavedView } from '@epicenter/folder/declaration';
import { createFolder, memoryHost, tick } from '@epicenter/folder/testing';
import { SaveError } from '@epicenter/folder/testing';
import { expectOk } from 'wellcrafted/testing';
import type { QueryAnswer } from '../ui/bindings.gen.js';

const { createViews, SQL } = await import('./views.svelte.js');
const grid: SavedView = { type: 'grid', title: 'Tasks', table: 'tasks' };

async function setup(
	source: Record<string, unknown> = { views: { a: grid } },
) {
	const memory = memoryHost({ 'epicenter.json': JSON.stringify(source) });
	const folder = expectOk(
		await createFolder(memory.storage, { tables: {} }),
	);
	const text = () => {
		const data = folder.file('epicenter.json')?.data;
		return typeof data === 'string' ? data : undefined;
	};
	const removeFailures: string[] = [];
	const views = createViews({
		onRemoveFailed: (message) => removeFailures.push(message),
		declaration: {
			text: () => text(),
			write: (value) => folder.write('epicenter.json', value),
		},
		saved: () => expectOk(readSavedViews(text() ?? '{}')).views,
	});
	return { ...memory, folder, views, removeFailures };
}

test('two saved view changes compose before either write lands', async () => {
	const fixture = await setup(
		{ views: { a: grid, b: grid }, metadata: 'kept' },
	);
	fixture.views.edit('saved:a', { ...grid, title: 'First' });
	fixture.views.save('saved:a');
	fixture.views.edit('saved:b', { ...grid, title: 'Second' });
	fixture.views.save('saved:b');
	expect(fixture.views.value('saved:a')?.title).toBe('First');
	expect(fixture.views.value('saved:b')?.title).toBe('Second');
	await tick(50);
	expect(JSON.parse(fixture.text('epicenter.json') ?? '{}')).toEqual({
		views: { a: { ...grid, title: 'First' }, b: { ...grid, title: 'Second' } },
		metadata: 'kept',
	});
	await fixture.folder.close();
});

test('failed publication restores the form for correction', async () => {
	const fixture = await setup();
	fixture.control.failPut.set(
		'epicenter.json',
		SaveError.StorageFailed({ cause: 'full' }).error!,
	);
	fixture.views.edit('saved:a', { ...grid, title: 'Typed' });
	fixture.views.save('saved:a');
	await tick(10);
	expect(fixture.views.dirty('saved:a')).toBe(true);
	expect(fixture.views.value('saved:a')?.title).toBe('Typed');
	expect(fixture.views.error('saved:a')).toContain('full');
	fixture.control.failPut.clear();
	await fixture.folder.close();
});

test('malformed source refuses submission and keeps the form', async () => {
	const fixture = await setup({ views: { a: grid } });
	fixture.outside('epicenter.json', '{');
	await tick();
	fixture.views.edit('saved:a', { ...grid, title: 'Typed' });
	expect(fixture.views.save('saved:a')).toBe('saved:a');
	expect(fixture.views.dirty('saved:a')).toBe(true);
	expect(fixture.views.error('saved:a')).toBeDefined();
	await fixture.folder.close();
});

test('remove preserves unrelated declaration data', async () => {
	const fixture = await setup({
		views: { a: grid, keep: { type: 'calendar' } },
		title: 'Raw title',
	});
	expect(fixture.views.remove('saved:a')).toBe(true);
	await tick(10);
	expect(JSON.parse(fixture.text('epicenter.json') ?? '{}')).toEqual({
		views: { keep: { type: 'calendar' } },
		title: 'Raw title',
	});
	await fixture.folder.close();
});

test('failed removal reports the error to its caller', async () => {
	const fixture = await setup();
	fixture.control.failPut.set('epicenter.json', SaveError.StorageFailed({ cause: 'full' }).error!);
	expect(fixture.views.remove('saved:a')).toBe(true);
	await tick(10);
	expect(fixture.removeFailures).toEqual([expect.stringContaining('View was not deleted:')]);
	expect(JSON.parse(fixture.text('epicenter.json') ?? '{}').views.a).toEqual(grid);
	await fixture.folder.close();
});

test('SQL completion belongs to the submitted statement', async () => {
	const fixture = await setup();
	fixture.views.edit(SQL, { type: 'sql', title: 'SQL', sql: 'select old' });
	const release = Promise.withResolvers<{ data: QueryAnswer; error: null }>();
	const running = fixture.views.run(SQL, () => release.promise);
	fixture.views.edit(SQL, { type: 'sql', title: 'SQL', sql: 'select new' });
	release.resolve({
		data: {
			columns: [],
			rows: [],
			truncated: false,
			warnings: [],
			excluded: [],
		},
		error: null,
	});
	await running;
	expect(fixture.views.execution(SQL)?.sql).toBe('select old');
	expect(fixture.views.value(SQL)).toMatchObject({ sql: 'select new' });
	await fixture.folder.close();
});

test('scratch and saved navigation identities do not collide', async () => {
	const fixture = await setup({ views: { sql: grid, files: grid } });
	expect(fixture.views.value('saved:sql')).toEqual(grid);
	expect(fixture.views.value(SQL)).toMatchObject({ type: 'sql' });
	expect(fixture.views.value('files')).toBeUndefined();
	await fixture.folder.close();
});
