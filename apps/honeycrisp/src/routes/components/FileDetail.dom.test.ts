/**
 * File Detail DOM Tests
 *
 * Mounts the note and file presentations over the folder mirror. Verifies
 * title, source, rich-text, and live repair input in the rendered controls.
 */
import 'fake-indexeddb/auto';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { click, type } from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

Range.prototype.getClientRects ??= () => [] as unknown as ReturnType<Range['getClientRects']>;
Range.prototype.getBoundingClientRect ??= () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;
const { flushSync, mount, unmount } = await import('svelte');
const { openNotes, noteText, until } = await import('../../lib/local.test-support.ts');
const FileDetail = (await import('./FileDetail.svelte')).default;
const Host = (await import('../../lib/ui-host.test-support.svelte')).default;
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); document.body.replaceChildren(); });

async function view(content = noteText({ title: 'Alpha' }), as: 'note' | 'text' = 'note') {
    const fixture = await openNotes({ throttleMs: 0 });
    cleanups.push(() => fixture.close());
    await fixture.write('notes/a.md', content);
    fixture.notes.open('notes/a.md', as);
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(Host, {
        target,
        props: { component: FileDetail as never, props: {
            notes: fixture.notes, path: 'notes/a.md',
            get as() { return fixture.notes.selected?.as ?? as; },
        } },
    });
    cleanups.push(() => unmount(component));
    await until(() => { flushSync(); return target.querySelector('section[aria-label="File"],section[aria-label="Note"]') !== null; }, 'detail');
    const get = <T extends Element>(selector: string) => {
        const element = target.querySelector<T>(selector);
        if (!element) throw new Error(`Missing ${selector}`);
        return element;
    };
    const render = () => flushSync();
    return { ...fixture, target, get, render };
}

test('title and Source text save and keep the rich editor mounted', async () => {
    const { target, get, render, folder } = await view();
    const rich = get<HTMLElement>('[aria-label="Note text"]');
    type(get<HTMLInputElement>('input[aria-label="Title"]'), 'Renamed');
    await until(() => folder.tables.notes.row('a')?.issues === null && folder.tables.notes.row('a')?.fields?.title === 'Renamed', 'title save');
    click(target, 'Source'); render();
    type(get<HTMLTextAreaElement>('textarea[aria-label="Markdown source"]'), 'New body\n');
    await until(() => folder.tables.notes.row('a')?.body === 'New body\n', 'body save');
    click(target, 'Rich text'); render();
    expect(get<HTMLElement>('[aria-label="Note text"]')).toBe(rich);
});

test('folder selection stays visible after a failed save and can retry', async () => {
    const { target, get, render, folder, failSaves } = await view();
    await folder.tables.folders.create('f', { fields: { name: 'Work', icon: null }, body: '' });
    await until(() => target.querySelector('select[aria-label="Folder"] option[value="folder:f"]') !== null, 'folder option');
    const selection = get<HTMLSelectElement>('select[aria-label="Folder"]');
    failSaves();
    selection.value = 'folder:f';
    selection.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => { render(); return target.textContent?.includes('Not saved:') ?? false; }, 'unsaved folder');
    expect(selection.value).toBe('folder:f');
    expect(folder.tables.notes.row('a')?.fields?.folderId).toBeNull();
    failSaves(false);
    click(target, 'Save again');
    await until(() => folder.tables.notes.row('a')?.fields?.folderId === 'f', 'retried folder');
    await until(() => { render(); return !target.textContent?.includes('Not saved:'); }, 'cleared folder error');
});

test('rich-text typing stays undoable after its save lands', async () => {
    const { get, render, folder } = await view();
    const rich = get<HTMLElement>('[aria-label="Note text"]');
    const line = rich.querySelector('p')?.firstChild;
    if (!(line instanceof Text)) throw new Error('Missing paragraph');
    line.data += '!';
    await Bun.sleep(0); render();
    await until(() => folder.tables.notes.row('a')?.body?.includes('Body.!') ?? false, 'rich save');
    render();
    expect(get<HTMLButtonElement>('button[aria-label="Undo"]').disabled).toBe(false);
});

test('title and Source replace lone surrogates before saving', async () => {
    const { target, get, render, folder } = await view();
    type(get<HTMLInputElement>('input[aria-label="Title"]'), 'Half \uD800');
    await until(() => folder.tables.notes.row('a')?.issues === null && folder.tables.notes.row('a')?.fields?.title === 'Half \uFFFD', 'well-formed title');
    click(target, 'Source'); render();
    type(get<HTMLTextAreaElement>('textarea[aria-label="Markdown source"]'), 'Half \uD800\n');
    await until(() => folder.tables.notes.row('a')?.body === 'Half \uFFFD\n', 'well-formed body');
});

test('different Source body starts a new rich-text history', async () => {
    const { target, get, render } = await view();
    const rich = get<HTMLElement>('[aria-label="Note text"]');
    const line = rich.querySelector('p')?.firstChild;
    if (!(line instanceof Text)) throw new Error('Missing paragraph');
    line.data += '!';
    await Bun.sleep(0); render();
    expect(get<HTMLButtonElement>('button[aria-label="Undo"]').disabled).toBe(false);
    click(target, 'Source'); render();
    type(get<HTMLTextAreaElement>('textarea[aria-label="Markdown source"]'), 'From source\n');
    click(target, 'Rich text'); render();
    await until(() => { render(); return rich.textContent?.includes('From source') ?? false; }, 'source body in rich view');
    expect(get<HTMLButtonElement>('button[aria-label="Undo"]').disabled).toBe(true);
});

test('another tab save appears in the open note', async () => {
    const { target, write, render } = await view();
    await write('notes/a.md', noteText({ title: 'From another tab', body: 'Elsewhere\n' }));
    await until(() => { render(); return target.querySelector<HTMLInputElement>('input[aria-label="Title"]')?.value === 'From another tab'; }, 'outside title');
    expect(target.querySelector('[aria-label="Note text"]')?.textContent).toContain('Elsewhere');
});

test('repair list follows typed file text before its save lands', async () => {
    const { target, get, render, raw } = await view('plain text\n', 'text');
    expect(target.textContent).toContain('Needs repair');
    const input = get<HTMLTextAreaElement>('textarea[aria-label="Contents of a.md"]');
    type(input, noteText()); render();
    expect(target.querySelector('[data-testid="row-issues"]')).toBeNull();
    expect(raw.file('notes/a.md')?.data).toBe('plain text\n');
});

test('rich editor keeps typing and Undo while an IndexedDB put is gated', async () => {
    const { target, render, folder } = await view(noteText({ body: '' }));
    const paragraph = () => target.querySelector<HTMLElement>('[aria-label="Note text"] p');
    if (!paragraph()) throw new Error('Missing paragraph');
    const put = IDBObjectStore.prototype.put;
    let started = false;
    let release: (() => void) | undefined;
    IDBObjectStore.prototype.put = function (value, key) {
        const request = key === undefined ? put.call(this, value) : put.call(this, value, key);
        if (this.name === 'meta' && !started) {
            started = true;
            const transaction = this.transaction;
            const complete = transaction.oncomplete;
            transaction.oncomplete = (event) => { release = () => complete?.call(transaction, event); };
        }
        return request;
    };
    cleanups.push(() => { IDBObjectStore.prototype.put = put; release?.(); });
    paragraph()!.textContent = 'a';
    await Bun.sleep(0); render();
    await until(() => started && release !== undefined, 'gated IndexedDB put');
    expect(target.querySelector('[aria-label="Note text"]')?.textContent).toContain('a');
    paragraph()!.textContent = 'ab';
    await Bun.sleep(0); render();
    expect(target.querySelector('[aria-label="Note text"]')?.textContent).toContain('ab');
    release?.();
    await until(() => folder.tables.notes.row('a')?.body === 'ab\n', 'second save');
    expect(folder.file('notes/a.md')?.data).toContain('ab');
    render();
    expect(target.querySelector('[aria-label="Note text"]')?.textContent).toContain('ab');
    expect(target.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.disabled).toBe(false);
    target.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.click();
    render();
    expect(target.querySelector('[aria-label="Note text"]')?.textContent).not.toContain('ab');
});
