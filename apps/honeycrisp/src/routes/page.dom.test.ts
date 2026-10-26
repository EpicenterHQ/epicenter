/**
 * Honeycrisp Page DOM Tests
 *
 * Mounts the real page with its opener and toaster. Verifies persisted notes,
 * live repair, and failed-save recovery shown to the user.
 */
import 'fake-indexeddb/auto';
import '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { until as folderUntil } from '@epicenter/folder/testing';
import { expectOk } from 'wellcrafted/testing';
import { button, type } from '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { honeycrispTables } from '../lib/data.js';

Range.prototype.getClientRects ??= () => [] as unknown as ReturnType<Range['getClientRects']>;
Range.prototype.getBoundingClientRect ??= () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;
const { flushSync, mount, unmount } = await import('svelte');
const { confirmationDialog } = await import('@epicenter/ui/confirmation-dialog');
const PageHost = (await import('../lib/page-host.test-support.svelte')).default;
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); document.body.replaceChildren(); });
const TITLE = 'section[aria-label="Note"] input[aria-label="Title"]';
const SOURCE = 'section[aria-label="Note"] textarea[aria-label="Markdown source"]';
const LIST = 'section[aria-label="Notes"]';
const noteText = ({ title = 'A' } = {}) =>
    `---\nfolderId: null\ntitle: ${JSON.stringify(title)}\npinned: false\ncreatedAt: "2026-10-01T00:00:00.000Z"\ndeletedAt: null\n---\nBody.\n`;
async function until(check: () => boolean, what: string) {
    try {
        await folderUntil(() => {
            flushSync();
            return check();
        }, { timeout: 3000 });
    } catch {
        throw new Error(`Timed out waiting for ${what}`);
    }
}
async function tab() {
    const folder = expectOk(await openFolder({ tables: honeycrispTables }));
    cleanups.push(() => folder.close());
    return folder;
}
async function openPage() {
    const target = document.createElement('div'); document.body.append(target);
    const component = mount(PageHost, { target });
    let mounted = true;
    const close = async () => {
        if (!mounted) return;
        mounted = false;
        await unmount(component);
        target.remove();
    };
    cleanups.push(close);
    await until(() => target.querySelector(LIST) !== null, 'notes list');
    const get = <T extends Element>(selector: string) => {
        const found = target.querySelector<T>(selector);
        if (!found) throw new Error(`Missing ${selector}`);
        return found;
    };
    return { target, get, close };
}

test('new note title and source persist across page close', async () => {
    globalThis.indexedDB = new IDBFactory();
    const page = await openPage();
    page.get<HTMLButtonElement>('button[aria-label="New note"]').click();
    await until(() => page.target.querySelector(TITLE) !== null, 'new note');
    type(page.get<HTMLInputElement>(TITLE), 'Groceries');
    await until(() => page.target.querySelector(LIST)?.textContent?.includes('Groceries') ?? false, 'saved title');
    button(page.target, 'Source').click();
    flushSync();
    type(page.get<HTMLTextAreaElement>(SOURCE), 'Milk\n');
    await until(() => page.target.querySelector(LIST)?.textContent?.includes('Milk') ?? false, 'saved body');
    await until(() => page.target.querySelector('[data-testid="status-summary"]')?.getAttribute('aria-label')?.includes('On this device') ?? false, 'idle status');
    const second = await tab();
    expect(second.tables.notes.rows()[0]?.body).toBe('Milk\n');
    await page.close();
    const reopened = await openPage();
    await until(() => reopened.target.querySelector(LIST)?.textContent?.includes('Groceries') ?? false, 'reopened note');
    expect(reopened.target.querySelector(LIST)?.textContent).toContain('Milk');
});

test('invalid note repairs as file and opens as note when typed text validates', async () => {
    globalThis.indexedDB = new IDBFactory();
    const seed = await tab();
    expectOk(await seed.write('notes/a.md', 'plain text\n'));
    const page = await openPage();
    await until(() => page.target.textContent?.includes('Needs repair') ?? false, 'repair listing');
    page.get<HTMLButtonElement>('[data-note="notes/a.md"]').click();
    await until(() => page.target.querySelector('textarea[aria-label="Contents of a.md"]') !== null, 'file editor');
    type(page.get<HTMLTextAreaElement>('textarea[aria-label="Contents of a.md"]'), noteText());
    flushSync();
    expect(page.target.querySelector('[data-testid="row-issues"]')).toBeNull();
    button(page.target, 'Open as note').click();
    await until(() => page.target.querySelector(TITLE) !== null, 'repaired note');
    await seed.refresh();
    expect(seed.tables.notes.row('a')?.issues).toBeNull();
    expect(seed.file('notes/a.md')?.data).toBe(noteText());
});

test('failed repair write keeps the file editor open', async () => {
    globalThis.indexedDB = new IDBFactory();
    const seed = await tab();
    expectOk(await seed.write('notes/a.md', 'plain text\n'));
    const page = await openPage();
    await until(() => page.target.querySelector('[data-note="notes/a.md"]') !== null, 'repair listing');
    page.get<HTMLButtonElement>('[data-note="notes/a.md"]').click();
    await until(() => page.target.querySelector('textarea[aria-label="Contents of a.md"]') !== null, 'file editor');
    type(page.get<HTMLTextAreaElement>('textarea[aria-label="Contents of a.md"]'), noteText());
    flushSync();
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = () => { throw new DOMException('Disk is full', 'QuotaExceededError'); };
    cleanups.push(() => { IDBObjectStore.prototype.put = put; });
    button(page.target, 'Open as note').click();
    await until(() => page.target.textContent?.includes('Not saved:') ?? false, 'repair failure');
    expect(page.target.querySelector('textarea[aria-label="Contents of a.md"]')).not.toBeNull();
    expect(seed.file('notes/a.md')?.data).toBe('plain text\n');
});

test('failed title save keeps input for retry and discard', async () => {
    globalThis.indexedDB = new IDBFactory();
    const seed = await tab();
    expectOk(await seed.write('notes/a.md', noteText({ title: 'Disk' })));
    const page = await openPage();
    await until(() => page.target.querySelector('[data-note="notes/a.md"]') !== null, 'note listing');
    page.get<HTMLButtonElement>('[data-note="notes/a.md"]').click();
    await until(() => page.target.querySelector(TITLE) !== null, 'note title');
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = () => { throw new DOMException('Disk is full', 'QuotaExceededError'); };
    cleanups.push(() => { IDBObjectStore.prototype.put = put; });
    type(page.get<HTMLInputElement>(TITLE), 'Typed');
    await until(() => page.target.textContent?.includes('Not saved:') ?? false, 'unsaved title');
    expect(page.get<HTMLInputElement>(TITLE).value).toBe('Typed');
    expect(page.target.textContent).toContain('Copy');
    IDBObjectStore.prototype.put = put;
    button(page.target, 'Save again').click();
    await until(() => seed.tables.notes.row('a')?.fields?.title === 'Typed', 'retried title');
    await until(() => !page.target.textContent?.includes('Not saved:'), 'cleared unsaved title');

    IDBObjectStore.prototype.put = () => { throw new DOMException('Disk is full', 'QuotaExceededError'); };
    type(page.get<HTMLInputElement>(TITLE), 'Discard me');
    await until(() => page.target.textContent?.includes('Not saved:') ?? false, 'second unsaved title');
    expect(page.get<HTMLInputElement>(TITLE).value).toBe('Discard me');
    button(page.target, 'Discard').click();
    await until(() => page.get<HTMLInputElement>(TITLE).value === 'Typed', 'discarded title');
    expect(page.target.textContent).not.toContain('Not saved:');
});

test('failed note creation reports its error at the command', async () => {
    globalThis.indexedDB = new IDBFactory();
    const page = await openPage();
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = () => { throw new DOMException('Disk is full', 'QuotaExceededError'); };
    cleanups.push(() => { IDBObjectStore.prototype.put = put; });
    page.get<HTMLButtonElement>('button[aria-label="New note"]').click();
    await until(() => page.target.textContent?.includes('Could not create the note') ?? false, 'create failure');
    expect(page.target.querySelector(TITLE)).toBeNull();
});

test('failed folder rename keeps the typed name available', async () => {
    globalThis.indexedDB = new IDBFactory();
    const page = await openPage();
    page.get<HTMLButtonElement>('button[aria-label="New folder"]').click();
    await until(() => page.target.querySelector('input[aria-label="Folder name"]') !== null, 'folder name input');
    const input = page.get<HTMLInputElement>('input[aria-label="Folder name"]');
    type(input, 'Project');
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = () => { throw new DOMException('Disk is full', 'QuotaExceededError'); };
    cleanups.push(() => { IDBObjectStore.prototype.put = put; });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until(() => document.body.textContent?.includes('Could not save the folder') ?? false, 'folder save failure');
    expect(page.get<HTMLInputElement>('input[aria-label="Folder name"]').value).toBe('Project');
});

test('deleting from Files drains the selected file draft before removal', async () => {
    globalThis.indexedDB = new IDBFactory();
    const seed = await tab();
    expectOk(await seed.write('notes/a.md', noteText()));
    const page = await openPage();
    await until(() => page.target.querySelector('[data-note="notes/a.md"]') !== null, 'note listing');
    page.get<HTMLButtonElement>('[data-note="notes/a.md"]').click();
    await until(() => page.target.querySelector(TITLE) !== null, 'note view');
    button(page.target, 'Edit as file').click();
    await until(() => page.target.querySelector('textarea[aria-label="Contents of a.md"]') !== null, 'file view');
    type(page.get<HTMLTextAreaElement>('textarea[aria-label="Contents of a.md"]'), 'Pending replacement');
    button(page.target, 'Files').click();
    await until(() => page.target.querySelector('[data-row="notes/a.md"]') !== null, 'file tree');
    page.get<HTMLElement>('[data-row="notes/a.md"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await confirmationDialog.confirm();
    await seed.refresh();
    expect(seed.file('notes/a.md')).toBeUndefined();
    await Bun.sleep(1100);
    await seed.refresh();
    expect(seed.file('notes/a.md')).toBeUndefined();
});
