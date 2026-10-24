/**
 * Saved-view forms submit into the declaration's real file editor. Raw input,
 * unknown JSON sections, failed publications and later form changes keep their
 * owner; SQL completions stay attached to the statement that was submitted.
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSavedViews, type SavedView } from '@epicenter/folder/declaration';
import { expectOk } from 'wellcrafted/testing';
import { FileError } from '../../../../packages/folder/src/errors.js';
import { createNativeFolder } from '../../../../packages/folder/src/native/engine.js';
import { nativeStorage } from '../../../../packages/folder/src/native/storage.js';
import type { QueryAnswer } from '../ui/bindings.gen';

const { createViews, SQL } = await import('./views.svelte.js');
const grid: SavedView = { type: 'grid', title: 'Tasks', table: 'tasks' };

/** Real declaration ownership, with publication failures controlled at the storage boundary. */
async function setup(source: Record<string, unknown> = { views: { a: grid } }) {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-view-forms-'));
	await writeFile(join(directory, 'epicenter.json'), JSON.stringify(source));
	const storage = nativeStorage(directory);
	let failure: string | undefined;
	const folder = createNativeFolder({
		storage: {
			...storage,
			put: (path, bytes, expectation) =>
				failure
					? Promise.resolve(
							FileError.Io({ path, operation: 'write', cause: failure }),
						)
					: storage.put(path, bytes, expectation),
		},
		tables: {},
		directory,
		saveAfterMs: 60_000,
	});
	const neutral = folder.files.document('epicenter.json');
	expectOk(await neutral.refresh());
	const declaration = neutral;
	const views = createViews({
		declaration,
		saved: () =>
			expectOk(readSavedViews(declaration.getSnapshot().text ?? '{}')).views,
	});
	return {
		folder,
		declaration,
		neutral,
		views,
		fail: (message?: string) => {
			failure = message;
		},
		stored: async () =>
			JSON.parse(await readFile(join(directory, 'epicenter.json'), 'utf8')),
		async close() {
			folder.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test('settings submission composes with current raw input and puts both in the declaration lane', async () => {
	const fixture = await setup();
	try {
		fixture.views.edit('saved:a', { ...grid, title: 'Typed settings' });
		expectOk(
			fixture.declaration.replace(
				JSON.stringify({
					views: { a: grid, future: { type: 'calendar' } },
					metadata: { raw: 'unfinished source input' },
				}),
			),
		);
		expect(fixture.views.save('saved:a')).toBe('saved:a');
		expect(fixture.views.dirty('saved:a')).toBe(false);
		expectOk(await fixture.declaration.save());
		expect(await fixture.stored()).toEqual({
			views: {
				a: { ...grid, title: 'Typed settings' },
				future: { type: 'calendar' },
			},
			metadata: { raw: 'unfinished source input' },
		});
	} finally {
		await fixture.close();
	}
});

test('a failed copy is already selected in owner text and a retry adds no second copy', async () => {
	const fixture = await setup();
	try {
		fixture.fail('disk full');
		fixture.views.edit('saved:a', { ...grid, title: 'The copy' });
		const target = fixture.views.save('saved:a', true);
		expect(target).not.toBe('saved:a');
		expect(fixture.views.value(target)?.title).toBe('The copy');
		expect(fixture.views.held).toEqual([]);
		await fixture.declaration.save();
		expect(fixture.neutral.getSnapshot().saveError?.message).toContain(
			'disk full',
		);
		fixture.views.edit(target, { ...grid, title: 'Later copy input' });
		expect(fixture.views.save(target)).toBe(target);
		await fixture.declaration.save();
		fixture.fail();
		expectOk(await fixture.declaration.save());
		const stored = await fixture.stored();
		expect(Object.keys(stored.views)).toHaveLength(2);
		expect(stored.views[target.slice('saved:'.length)].title).toBe(
			'Later copy input',
		);
		expect(stored.views.a).toEqual(grid);
	} finally {
		await fixture.close();
	}
});

test('malformed current source refuses submission and keeps the unsubmitted form', async () => {
	const fixture = await setup();
	try {
		fixture.views.edit('saved:a', { ...grid, title: 'Held settings' });
		expectOk(fixture.declaration.replace('{broken'));
		expect(fixture.views.save('saved:a')).toBe('saved:a');
		expect(fixture.views.error('saved:a')).toBeDefined();
		expect(fixture.views.dirty('saved:a')).toBe(true);
		expect(fixture.neutral.getSnapshot().text).toBe('{broken');
		fixture.neutral.discard();
	} finally {
		await fixture.close();
	}
});

test('form reset reads current owner values while submitted deletion composes with raw metadata', async () => {
	const fixture = await setup();
	try {
		fixture.views.edit('saved:a', { ...grid, title: 'Unsubmitted' });
		fixture.views.reload('saved:a');
		expect(fixture.views.value('saved:a')).toEqual(grid);
		expectOk(
			fixture.declaration.replace(
				JSON.stringify({
					views: { a: grid, keep: { type: 'calendar' } },
					title: 'Raw title',
				}),
			),
		);
		expect(fixture.views.remove('saved:a')).toBe(true);
		expect(fixture.views.value('saved:a')).toBeUndefined();
		expectOk(await fixture.declaration.save());
		expect(await fixture.stored()).toEqual({
			views: { keep: { type: 'calendar' } },
			title: 'Raw title',
		});
	} finally {
		await fixture.close();
	}
});

test('SQL completion belongs to its submitted key and statement, preserving later form input', async () => {
	const fixture = await setup();
	try {
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
		expect(fixture.views.execution(SQL)?.running).toBe(false);
		expect(fixture.views.value(SQL)).toMatchObject({ sql: 'select new' });
	} finally {
		await fixture.close();
	}
});

test('scratch and saved navigation identities cannot collide', async () => {
	const fixture = await setup({ views: { sql: grid, files: grid } });
	try {
		expect(fixture.views.value('saved:sql')).toEqual(grid);
		expect(fixture.views.value(SQL)).toMatchObject({ type: 'sql' });
		expect(fixture.views.value('files')).toBeUndefined();
	} finally {
		await fixture.close();
	}
});
