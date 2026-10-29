/**
 * Attachment Tests
 *
 * `attachment` mounted in jsdom over a repository on a replica in this
 * process: the four states, and the object URL's life. jsdom has no object
 * URLs, so the test counts the ones made and revoked.
 *
 * Key behaviors:
 * - Bytes here show through one object URL, revoked when the path changes and when the component goes
 * - A path with no blob is missing; other bytes at the same path open again, with a new URL
 * - An open that cannot reach its bytes is unavailable, and `retry` opens it again
 */
import '../svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { defineApp, type Files, openLocalRepository, OpenError } from '@epicenter/repository';
import { openBunSqlite } from '@epicenter/repository/bun';
import { openReplica } from '@epicenter/repository/client';
import { unwrap } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';

const { flushSync, mount, unmount } = await import('svelte');
const { default: AttachmentHost } = await import('../fixtures/AttachmentHost.svelte');

const made: string[] = [];
const revoked: string[] = [];
URL.createObjectURL = () => {
	const url = `blob:test/${made.length}`;
	made.push(url);
	return url;
};
URL.revokeObjectURL = (url) => void revoked.push(url);

const app = defineApp({ audio: { path: 'recordings/{stem}.webm', blob: true } });
const cleanups: (() => unknown)[] = [];
afterEach(() => {
	for (const step of cleanups.splice(0).reverse()) step();
	document.body.replaceChildren();
	made.length = 0;
	revoked.length = 0;
});

/** Let opens, changes and effects settle. */
async function settle() {
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
	}
}

async function setup(open?: (files: Files) => Files['open']) {
	const replica = unwrap(openReplica({ driver: openBunSqlite(), binding: { repository: 'r', server: null, account: null }, device: 'd', app, after: () => {}, now: () => 0 }));
	const repo = openLocalRepository({ app, replica });
	cleanups.push(() => repo.close());
	await settle();
	const source = open === undefined ? repo : { ...repo, files: { ...repo.files, open: open(repo.files) } };
	const target = document.createElement('div');
	document.body.append(target);
	return { repo, source, target };
}

const statusIn = (target: HTMLElement) => target.querySelector('[data-testid="status"]')?.textContent;

test('bytes here show through one object URL, revoked when the path changes and when the component goes', async () => {
	const { repo, source, target } = await setup();
	expectOk(await repo.audio.create({ stem: 'r1' }, new Blob(['one'])));
	expectOk(await repo.audio.create({ stem: 'r2' }, new Blob(['two'])));
	let component = mount(AttachmentHost, { target, props: { repo: source, path: 'recordings/r1.webm' } });
	await settle();
	expect(statusIn(target)).toBe('here');
	expect(target.querySelector('audio')?.getAttribute('src')).toBe('blob:test/0');
	unmount(component);
	expect(revoked).toEqual(['blob:test/0']);
	component = mount(AttachmentHost, { target, props: { repo: source, path: 'recordings/none.webm' } });
	await settle();
	expect(statusIn(target)).toBe('missing');
	unmount(component);
	// Other bytes at the path: opened again, the old URL revoked.
	component = mount(AttachmentHost, { target, props: { repo: source, path: 'recordings/r2.webm' } });
	cleanups.push(() => unmount(component));
	await settle();
	const first = made.at(-1) ?? '';
	expectOk(await repo.audio.replace({ stem: 'r2' }, new Blob(['two, again'])));
	await settle();
	expect(statusIn(target)).toBe('here');
	expect(revoked).toContain(first);
	expect(made.at(-1)).not.toBe(first);
});

test('an open that cannot reach its bytes is unavailable, and retry opens it again', async () => {
	let failing = true;
	const { repo, source, target } = await setup((files) => async (path) => (failing ? OpenError.Unavailable({ path, reason: 'offline' }) : files.open(path)));
	expectOk(await repo.audio.create({ stem: 'r1' }, new Blob(['one'])));
	const component = mount(AttachmentHost, { target, props: { repo: source, path: 'recordings/r1.webm' } });
	cleanups.push(() => unmount(component));
	await settle();
	expect(statusIn(target)).toBe('unavailable');
	failing = false;
	(target.querySelector('[data-testid="retry"]') as HTMLButtonElement).click();
	await settle();
	expect(statusIn(target)).toBe('here');
});
