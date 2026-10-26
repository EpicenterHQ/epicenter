/**
 * File Detail Refresh DOM Tests
 *
 * Verifies that the file view follows mirror changes from another tab,
 * reports deletion, and bounds large text editing.
 */
import 'fake-indexeddb/auto';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { type } from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { openNotes, until } = await import('../../lib/local.test-support.ts');
const FileDetail = (await import('./FileDetail.svelte')).default;
const Host = (await import('../../lib/ui-host.test-support.svelte')).default;
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); document.body.replaceChildren(); });
async function open(path = 'draft.txt', content: string | Uint8Array = 'Original text') {
    const fixture = await openNotes();
    cleanups.push(() => fixture.close());
    if (typeof content === 'string') await fixture.write(path, content);
    else {
        const tab = await fixture.otherTab();
        expectOk(await tab.write(path, content));
        await until(() => fixture.folder.file(path) !== undefined, 'media file');
    }
    const target = document.createElement('main');
    document.body.append(target);
    const component = mount(Host, { target, props: { component: FileDetail as never, props: { notes: fixture.notes, path, as: 'text' } } });
    cleanups.push(() => unmount(component));
    const input = () => target.querySelector<HTMLTextAreaElement>(`textarea[aria-label="Contents of ${path.split('/').at(-1)}"]`);
    const shows = (check: () => boolean, what: string) => until(() => { flushSync(); return check(); }, what);
    await shows(() => input() !== null || typeof content !== 'string' || content.length > 1024 * 1024, 'file view');
    return { ...fixture, target, input, shows };
}

test('a clean file view follows another tab save', async () => {
    const { write, input, shows } = await open();
    await write('draft.txt', 'Their text');
    await shows(() => input()?.value === 'Their text', 'their text');
});

test('whole-file input replaces lone surrogates before saving', async () => {
    const { folder, input, shows } = await open();
    type(input(), 'Half \uD800');
    await shows(() => folder.file('draft.txt')?.data === 'Half \uFFFD', 'well-formed file');
    expect(input()?.value).toBe('Half \uFFFD');
});

test('a file deleted elsewhere shows it is gone', async () => {
    const { remove, shows, target } = await open();
    await remove('draft.txt');
    await shows(() => target.textContent?.includes('no longer in the folder') ?? false, 'deletion');
});

test('a whole-file edit queued before outside deletion does not recreate the file', async () => {
    const { remove, folder, input, shows, target } = await open();
    type(input(), 'Saved before deletion');
    await folder.idle();
    expect(folder.file('draft.txt')?.data).toBe('Saved before deletion');
    await remove('draft.txt');
    await shows(() => target.textContent?.includes('no longer in the folder') ?? false, 'outside deletion');
    await folder.idle();
    expect(folder.file('draft.txt')).toBeUndefined();
    expect(input()).toBeNull();
});

test('text larger than 1 MB is listed without an editor', async () => {
    const { target, shows } = await open('large.txt', 'x'.repeat(1024 * 1024 + 1));
    await shows(() => target.textContent?.includes('larger than 1 MB') ?? false, 'size limit');
    expect(target.querySelector('textarea')).toBeNull();
});

test('media file shows its kind without a made-up size', async () => {
    const { target, shows } = await open('photo.png', new Uint8Array([1, 2, 3]));
    await shows(() => target.textContent?.includes('PNG file') ?? false, 'media kind');
    expect(target.textContent).not.toContain('0 bytes');
    expect(target.querySelector('textarea')).toBeNull();
});
