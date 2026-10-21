/**
 * Effective buffer snapshots and command feedback over real browser storage.
 * Covers source availability independent of refusals, listener reentrancy,
 * private error lifetimes, and self-contained recovery identity.
 */
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openRepository } from './browser/repository.js';
import { unsavedOf } from './edit-buffer.test-support.js';
import { folderHandle } from './handle.js';
import { ReadError } from './shared/errors.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});
async function setup(source = '---\ntitle: A\n---\nBody\n') {
	globalThis.indexedDB = new IDBFactory();
	const tables = { notes: Type.Object({ title: Type.String() }) };
	const repository = await openRepository(crypto.randomUUID(), tables);
	const engine = {
		files: { ...repository.files },
		tables: repository.tables,
		subscribe: repository.onChange,
		close: repository.close,
	};
	const folder = folderHandle(engine, tables, { saveAfterMs: 60_000 });
	cleanup.push(() => folder.close());
	expectOk(await folder.files.write('notes/a.md', null, source));
	return {
		folder,
		engine,
		repository,
		edit: folder.files.edit('notes/a.md'),
		source,
	};
}

test('a pre-read refusal stays unread and expires when source arrives', async () => {
	const { edit, folder } = await setup();
	expectErr(edit.replaceText('too early'));
	expect(edit.getBuffer()).toMatchObject({
		status: 'unread',
		error: { name: 'NoSource' },
	});
	expectOk(await edit.read());
	const buffer = edit.getBuffer();
	expect(buffer.status).toBe('ready');
	expect(buffer.error).toBeUndefined();
	expect(folder.tables.notes.edit('a').getBuffer()).toBe(buffer);
	expect(edit.getBuffer()).toBe(buffer);
});

test('a repeating refusal listener observes one unchanged issue without recursive work', async () => {
	const { edit } = await setup();
	let calls = 0;
	cleanup.push(
		edit.subscribe(() => {
			calls++;
			if (calls < 5) edit.replaceText('still no source');
		}),
	);
	expectErr(edit.replaceText('no source'));
	await Promise.resolve();
	await Promise.resolve();
	expect(calls).toBe(1);
	expect(edit.getBuffer()).toMatchObject({
		status: 'unread',
		error: { name: 'NoSource' },
	});
});

test('a listener refusal survives the outer accepted command', async () => {
	const { edit } = await setup();
	expectOk(await edit.read());
	let refused = false;
	cleanup.push(
		edit.subscribe(() => {
			if (refused) return;
			refused = true;
			expectErr(
				edit.change({ fields: { title: 'cannot patch malformed header' } }),
			);
		}),
	);
	expectOk(edit.replaceText('---\ntitle: [broken\n---\nBody'));
	await Promise.resolve();
	expect(edit.getBuffer()).toMatchObject({
		status: 'ready',
		error: { name: 'InvalidFields' },
	});
});

test('refusal precedence retains the underlying read failure until a successful read', async () => {
	const { edit, engine } = await setup('---\ntitle: [broken\n---\nBody');
	expectOk(await edit.read());
	const read = engine.files.read;
	engine.files.read = async () =>
		ReadError.StorageFailed({ cause: new Error('offline') });
	expectErr(await edit.read());
	expectErr(edit.change({ fields: { title: 'blocked' } }));
	expect(edit.getBuffer().error?.name).toBe('InvalidFields');
	expectOk(edit.replaceText(edit.getText()!));
	expect(edit.getBuffer().error?.name).toBe('StorageFailed');
	engine.files.read = read;
	expectOk(await edit.read());
	expect(edit.getBuffer().error).toBeUndefined();
});

test('a nontext refusal expires when storage becomes missing', async () => {
	const { folder, edit, source } = await setup();
	expectOk(await edit.read());
	const binary = new Uint8Array([255, 0]);
	expectOk(await folder.files.write(edit.path, source, binary));
	expectErr(edit.replaceText('refused'));
	expect(edit.getBuffer().error?.name).toBe('NotText');
	expectOk(await folder.files.delete(edit.path, binary));
	expect(edit.getBuffer()).toMatchObject({
		status: 'unavailable',
		error: { name: 'SourceUnavailable', reason: 'missing' },
	});
});

test('changed conflict resolution returns its own conflict even if a listener discards', async () => {
	const { edit, repository, source } = await setup();
	expectOk(await edit.read());
	expectOk(edit.replaceText('mine'));
	expectOk(await repository.files.write(edit.path, source, 'outside'));
	expect(expectErr(await edit.save()).name).toBe('Conflict');
	expectOk(await repository.files.write(edit.path, 'outside', 'new outside'));
	let discarded = false;
	cleanup.push(
		edit.subscribe(() => {
			const unsaved = unsavedOf(edit);
			if (discarded || unsaved?.status !== 'conflict') return;
			const current = unsaved.error.current;
			const text =
				typeof current === 'string'
					? current
					: current === null
						? undefined
						: new TextDecoder().decode(current);
			if (text !== 'new outside') return;
			discarded = true;
			expectOk(edit.discard());
		}),
	);
	const result = await edit.resolveConflict('current');
	expect(expectErr(result).name).toBe('Conflict');
	expect(discarded).toBe(true);
	expect(unsavedOf(edit)).toBeUndefined();
});

test('recovery entries keep their identity over buffer read feedback and detach exact text', async () => {
	const { edit, engine, folder } = await setup();
	expectOk(await edit.read());
	expectOk(edit.replaceText('mine'));
	// An outside replacement gives the real storage engine a conflict to report.
	expectOk(
		await folder.files.write(
			edit.path,
			'---\ntitle: A\n---\nBody\n',
			'outside',
		),
	);
	expectErr(await edit.save());
	const recovery = folder.getStatus().failures[0]!;
	const read = engine.files.read;
	engine.files.read = async () =>
		ReadError.StorageFailed({ cause: new Error('offline') });
	expectErr(await edit.read());
	expect(folder.getStatus().failures[0]).toBe(recovery);
	const discarded = expectOk(edit.discard());
	expect(discarded).toBe(recovery);
	expect(discarded?.text).toBe('mine');
	engine.files.read = read;
});

test('a listener refusal after deletion survives the completed delete command', async () => {
	const { edit } = await setup();
	expectOk(await edit.read());
	let refused = false;
	cleanup.push(
		edit.subscribe(() => {
			if (
				refused ||
				edit.isLocked() ||
				edit.getBuffer().status !== 'unavailable'
			)
				return;
			refused = true;
			expectErr(edit.change({ body: 'too late' }));
		}),
	);
	expectOk(await edit.delete());
	await Promise.resolve();
	expect(refused).toBe(true);
	expect(edit.getBuffer()).toMatchObject({
		status: 'unavailable',
		error: { name: 'NoSource' },
	});
});
