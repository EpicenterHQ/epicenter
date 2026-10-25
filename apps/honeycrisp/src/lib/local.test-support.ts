/** Honeycrisp's notes over a fresh in-memory browser folder. */
import { type Folder } from '@epicenter/folder/next';
import { openFolder } from '@epicenter/folder/next/browser';
import { svelteFolder } from '@epicenter/svelte/folder-next';
import { expectOk } from 'wellcrafted/testing';
import { type HoneycrispTables, honeycrispTables, type NoteRow } from './data.js';
import { createNotes, type Notes } from './notes.svelte.js';

export async function openNotes({ throttleMs = 0 } = {}) {
    globalThis.indexedDB = new IDBFactory();
    const raw = expectOk(await openFolder({ tables: honeycrispTables, throttleMs }));
    const folder = svelteFolder(raw);
    const notes = createNotes(folder);
    const others: Folder<HoneycrispTables>[] = [];
    const put = IDBObjectStore.prototype.put;
    async function otherTab() {
        const tab = expectOk(await openFolder({ tables: honeycrispTables, throttleMs: 0 }));
        others.push(tab);
        return tab;
    }
    let writer: Folder<HoneycrispTables> | undefined;
    return {
        raw, folder, notes, otherTab,
        async write(path: string, text: string) {
            writer ??= await otherTab();
            expectOk(await writer.write(path, text));
            await until(() => folder.file(path)?.data === text, `mirror to show ${path}`);
        },
        async remove(path: string) {
            writer ??= await otherTab();
            expectOk(await writer.delete(path));
            await until(() => folder.file(path) === undefined, `mirror to remove ${path}`);
        },
        async text(path: string): Promise<string | undefined> {
            const tab = await otherTab();
            const data = tab.file(path)?.data;
            return typeof data === 'string' ? data : undefined;
        },
        failSaves(on = true) {
            IDBObjectStore.prototype.put = on
                ? () => { throw new DOMException('Disk is full', 'QuotaExceededError'); }
                : put;
        },
        async close() {
            IDBObjectStore.prototype.put = put;
            await raw.close();
            for (const tab of others.splice(0)) await tab.close();
        },
    };
}
export type NotesFixture = Awaited<ReturnType<typeof openNotes>>;

export async function until(check: () => boolean, what: string) {
    for (let attempt = 0; attempt < 1000; attempt++) {
        if (check()) return;
        await Bun.sleep(2);
    }
    throw new Error(`Timed out waiting for ${what}`);
}
export async function quiet(notes: Notes) {
    await until(() => !notes.folder.saving, 'writes to settle');
}
export const rows = (notes: Notes): readonly NoteRow[] => notes.folder.tables.notes.rows;
export function shown(notes: Notes, id: string) {
    const row = notes.folder.tables.notes.row(id);
    if (row?.issues !== null || row === undefined) throw new Error(`No valid note ${id} is shown`);
    return row;
}

/** A note's text in Honeycrisp's form, with a key Honeycrisp does not name. */
export function noteText({
	title = 'A',
	body = 'Body.\n',
	extra = 'owner:\n  name: one\n  tags: [two]\n',
	folderId = 'null',
	pinned = 'false',
}: {
	title?: string;
	body?: string;
	extra?: string;
	folderId?: string;
	pinned?: string;
} = {}) {
	return [
		'---',
		`folderId: ${folderId}`,
		`title: ${JSON.stringify(title)}`,
		`pinned: ${pinned}`,
		'createdAt: "2026-10-01T00:00:00.000Z"',
		'deletedAt: null',
		`${extra}---`,
		body,
	].join('\n');
}

/** A folder's text in Honeycrisp's form. */
export const folderText = (name: string) =>
	`---\nname: ${JSON.stringify(name)}\nicon: null\n---\n`;
