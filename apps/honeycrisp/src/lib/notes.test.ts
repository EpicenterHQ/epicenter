/**
 * Notes Tests
 *
 * Exercises Honeycrisp actions over the folder mirror and another browser tab.
 * Key behaviors: saved rows, outside changes, repair, folder deletion, and close.
 */
import 'fake-indexeddb/auto';
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { createFolder, memoryHost } from '@epicenter/folder/next/testing';
import { svelteFolder } from '@epicenter/svelte/folder-next';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { ReadError } from '../../../../packages/folder/src/shared/errors.js';
import { honeycrispTables } from './data.js';
import type { NotesFixture } from './local.test-support.ts';

const { openNotes, until, shown, noteText, folderText } = await import('./local.test-support.ts');
const { createNotes, foldersOf, repairsOf } = await import('./notes.svelte.ts');
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });
const A = 'notes/a.md';
async function setup(files: Record<string, string> = { [A]: noteText() }) {
    const fixture = await openNotes();
    cleanup.push(() => fixture.close());
    for (const [path, text] of Object.entries(files)) await fixture.write(path, text);
    return fixture;
}
const text = async (fixture: NotesFixture, path = A) => (await fixture.text(path)) ?? '';

test('opening writes nothing; row updates keep unnamed keys', async () => {
    const fixture = await setup();
    const before = await text(fixture);
    fixture.notes.open(A);
    expect(await text(fixture)).toBe(before);
    expectOk(await fixture.folder.tables.notes.update('a', { fields: { title: 'Renamed' }, body: 'Edited.\n' }));
    const saved = await text(fixture);
    expect(saved).toContain('title: Renamed');
    expect(saved).toContain('Edited.');
    expect(saved).toContain('owner:');
    expect(shown(fixture.notes, 'a').fields.title).toBe('Renamed');
    expect(fixture.notes.saves.short).toBe('Saved');
});

test('outside field change merges beside a body update', async () => {
    const fixture = await setup();
    await fixture.write(A, noteText({ title: 'Other tab' }));
    await until(() => shown(fixture.notes, 'a').fields.title === 'Other tab', 'outside title');
    expectOk(await fixture.folder.tables.notes.update('a', { body: 'Mine.\n' }));
    const saved = await text(fixture);
    expect(saved).toContain('title: Other tab');
    expect(saved).toContain('Mine.');
});

test('another tab save appears in the mirror', async () => {
    const fixture = await setup();
    await fixture.write(A, noteText({ title: 'Elsewhere' }));
    await until(() => shown(fixture.notes, 'a').fields.title === 'Elsewhere', 'outside note');
});

test('invalid note is listed for repair and opens as text', async () => {
    const fixture = await setup({ [A]: 'plain text\n' });
    expect(repairsOf(fixture.folder.tables.notes.rows).map((row) => row.path)).toEqual([A]);
    fixture.notes.open(A);
    expect(fixture.notes.selected?.as).toBe('text');
    expectOk(await fixture.folder.write(A, noteText()));
    expect(shown(fixture.notes, 'a').fields.title).toBe('A');
});

test('deleting a folder moves its notes out before removing it', async () => {
    const fixture = await setup({ [A]: noteText({ folderId: 'f' }), 'folders/f.md': folderText('Work') });
    const entry = foldersOf(fixture.folder.tables.folders.rows)[0];
    if (!entry) throw new Error('Missing folder');
    expect(await fixture.notes.deleteFolder(entry)).toBeUndefined();
    expect(shown(fixture.notes, 'a').fields.folderId).toBeNull();
    expect(fixture.folder.file('folders/f.md')).toBeUndefined();
});

test('deleting a folder refuses when a note cannot identify its folder', async () => {
    const fixture = await setup({ [A]: 'broken\n', 'folders/f.md': folderText('Work') });
    const entry = foldersOf(fixture.folder.tables.folders.rows)[0];
    if (!entry) throw new Error('Missing folder');
    expect(await fixture.notes.deleteFolder(entry)).toContain('cannot be read');
    expect(fixture.folder.file('folders/f.md')).toBeDefined();
});

test('deleting a folder refuses when a note could not be read', async () => {
    const host = memoryHost({ [A]: noteText({ folderId: 'f' }), 'folders/f.md': folderText('Work') });
    const storage = {
        ...host.storage,
        async read(paths: readonly string[]) {
            const answer = new Map(await host.storage.read(paths));
            if (paths.includes(A)) answer.set(A, ReadError.StorageFailed({ cause: 'read refused' }));
            return answer;
        },
    };
    const raw = expectOk(await createFolder(storage, { tables: honeycrispTables }));
    cleanup.push(() => raw.close());
    const notes = createNotes(svelteFolder(raw));
    const entry = foldersOf(notes.folder.tables.folders.rows)[0];
    if (!entry) throw new Error('Missing folder');
    expect(notes.folder.tables.notes.row('a')?.issues?.[0]?.kind).toBe('unreadable');
    expect(await notes.deleteFolder(entry)).toContain('cannot be read');
    expect(host.text('folders/f.md')).toBeDefined();
});

test('folder name update saves', async () => {
    const fixture = await setup({ 'folders/f.md': folderText('Old') });
    expect(await fixture.notes.patchFolder('folders/f.md', { name: 'New' })).toBeUndefined();
    expect((await text(fixture, 'folders/f.md'))).toContain('name: New');
});

test('deleting a selected note closes its detail', async () => {
    const fixture = await setup();
    fixture.notes.open(A);
    expect(await fixture.notes.delete({ path: A, title: 'A' })).toBeUndefined();
    expect(fixture.notes.selected).toBeUndefined();
});

test('name collision refuses file creation', async () => {
    const fixture = await setup();
    expect(await fixture.notes.createFile('notes', 'a.md')).toContain('already exists');
});

test('list action on a deleted note returns not listed', async () => {
    const fixture = await setup();
    await fixture.remove(A);
    expect(await fixture.notes.patchNote(A, { pinned: true })).toContain('not in the list');
});

test('close sends waiting writes and later writes answer Closed', async () => {
    const fixture = await setup();
    const saved = fixture.raw.tables.notes.update('a', { fields: { title: 'Last' } });
    await fixture.raw.close();
    expectOk(await saved);
    const error = expectErr(await fixture.raw.tables.notes.update('a', { fields: { title: 'Too late' } }));
    expect(error.name).toBe('Closed');
});
