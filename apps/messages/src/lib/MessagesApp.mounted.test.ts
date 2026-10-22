/** Draft previews over real Markdown files and Folder-owned pending input. */
import '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFolderContext } from '@epicenter/svelte/folder';
import { expectOk } from 'wellcrafted/testing';
import { FileError } from '../../../../packages/folder/src/errors.js';
import { createNativeFolder } from '../../../../packages/folder/src/native/engine.js';
import { nativeStorage } from '../../../../packages/folder/src/native/storage.js';
import {
	click,
	type,
} from '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { createDemoBackend } from './backend.js';
import { messagesTables } from './definition.js';
import { draftId } from './drafts.js';
import { seedDraft } from './drafts.test-support.js';

mock.module('$app/navigation', () => ({ beforeNavigate() {} }));
const { flushSync, mount, unmount } = await import('svelte');
const { default: MessagesApp } = await import('./MessagesApp.svelte');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

async function until(check: () => boolean, what: string) {
	for (let attempt = 0; attempt < 500; attempt++) {
		flushSync();
		if (check()) return;
		await Bun.sleep(4);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

async function setup(saveAfterMs = 60_000) {
	const directory = await mkdtemp(join(tmpdir(), 'messages-draft-preview-'));
	const storage = nativeStorage(directory);
	let failing = false;
	const folder = createNativeFolder({
		directory: `bun:${directory}`,
		tables: messagesTables,
		saveAfterMs,
		storage: {
			...storage,
			put: (path, bytes, ifMatch) =>
				failing
					? Promise.resolve(
							FileError.Io({
								path,
								operation: 'write',
								cause: new Error('Disk unavailable'),
							}),
						)
					: storage.put(path, bytes, ifMatch),
		},
	});
	const context = createFolderContext(folder);
	const target = document.createElement('main');
	document.body.append(target);
	const app = mount(MessagesApp, { target, props: { context } });
	cleanups.push(async () => {
		failing = false;
		await unmount(app);
		await context.close();
		target.remove();
		await rm(directory, { recursive: true, force: true });
	});
	function conversation(name: string) {
		const row = [
			...target.querySelectorAll<HTMLButtonElement>(
				'[aria-label="Conversations"] button',
			),
		].find((button) => button.textContent?.includes(name));
		if (row === undefined) throw new Error(`No conversation named ${name}`);
		return row;
	}
	const composer = () =>
		target.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="Message"], textarea#reply',
		);
	async function open(name: string) {
		conversation(name).click();
		await until(() => composer() !== null, `${name}'s composer`);
	}
	await until(
		() => target.textContent?.includes('Maya Chen') === true,
		'conversations',
	);
	return {
		folder,
		context,
		directory,
		target,
		conversation,
		composer,
		open,
		failWrites: (next: boolean) => {
			failing = next;
		},
	};
}

test('a preview follows pending Markdown input across chat switches and disappears when emptied', async () => {
	const app = await setup();
	await app.open('Maya Chen');
	const id = await draftId(createDemoBackend(), 'demo-maya');
	const edit = app.folder.tables.drafts.document(id);
	await until(
		() => app.context.queryClient.isFetching() === 0,
		'the draft listing',
	);
	type(app.composer(), 'Saturday at ten.\nI’ll bring the address.');
	await until(
		() =>
			app
				.conversation('Maya Chen')
				.textContent?.includes(
					'Draft: Saturday at ten. I’ll bring the address.',
				) === true,
		'the unsaved preview',
	);
	expect(edit.getSnapshot().isSaving).toBe(false);
	expect(expectOk(await app.folder.tables.drafts.get(id))).toBeUndefined();
	await app.open('Community garden');
	expect(app.composer()?.value).toBe('');
	expect(app.conversation('Maya Chen').textContent).toContain(
		'Draft: Saturday at ten. I’ll bring the address.',
	);
	expect(app.conversation('Community garden').textContent).not.toContain(
		'Draft:',
	);
	await app.context.refresh([`drafts/${id}.md`]);
	expect(app.conversation('Maya Chen').textContent).toContain(
		'I’ll bring the address.',
	);
	await app.open('Maya Chen');
	expect(app.composer()?.value).toBe(
		'Saturday at ten.\nI’ll bring the address.',
	);
	type(app.composer(), ' \n ');
	await until(
		() => !app.conversation('Maya Chen').textContent?.includes('Draft:'),
		'the empty preview to clear',
	);
	expect(app.conversation('Maya Chen').textContent).toContain(
		'Shall we try the new café on Saturday?',
	);
});

test('saved Markdown supplies previews without opening chats and keeps modes and profiles separate', async () => {
	const app = await setup();
	const demo = createDemoBackend();
	const maya = await seedDraft(app.folder, demo, 'demo-maya');
	expectOk(
		await app.folder.tables.drafts.document(maya.id).save({
			body: 'Saved in Markdown',
		}),
	);
	const live = await seedDraft(
		app.folder,
		{ ...demo, mode: 'live' },
		'demo-garden',
	);
	expectOk(
		await app.folder.tables.drafts.document(live.id).save({
			body: 'Live private draft',
		}),
	);
	const other = await seedDraft(
		app.folder,
		{ ...demo, profile: 'another-account' },
		'demo-noah',
	);
	expectOk(
		await app.folder.tables.drafts.document(other.id).save({
			body: 'Another account’s draft',
		}),
	);
	await until(
		() =>
			app
				.conversation('Maya Chen')
				.textContent?.includes('Draft: Saved in Markdown') === true,
		'the saved preview',
	);
	expect(app.conversation('Community garden').textContent).not.toContain(
		'Live private draft',
	);
	expect(app.conversation('Noah Patel').textContent).not.toContain(
		'Another account’s draft',
	);
	expect(app.composer()).toBeNull();
	const path = `drafts/${maya.id}.md`;
	const saved = expectOk(await app.folder.tables.drafts.get(maya.id));
	if (saved === undefined) throw new Error('The draft disappeared');
	await writeFile(
		join(app.directory, path),
		saved.text.replace('Saved in Markdown', 'Changed outside Messages'),
	);
	await app.context.refresh([path]);
	await until(
		() =>
			app
				.conversation('Maya Chen')
				.textContent?.includes('Draft: Changed outside Messages') === true,
		'the outside edit',
	);
	expect(expectOk(await app.folder.files.list())).toHaveLength(3);
});

test('failed autosave retains its preview, uncertain sends are distinct, and sending clears Draft', async () => {
	const app = await setup(60);
	await app.open('Community garden');
	await app.open('Maya Chen');
	const id = await draftId(createDemoBackend(), 'demo-maya');
	app.failWrites(true);
	type(app.composer(), 'Keep this reply');
	await app.open('Community garden');
	await until(
		() =>
			app.folder.tables.drafts.document(id).getSnapshot().saveError !==
			undefined,
		'the failed autosave',
	);
	expect(app.conversation('Maya Chen').textContent).toContain(
		'Draft: Keep this reply',
	);
	app.failWrites(false);
	await app.open('Maya Chen');
	expect(app.composer()?.value).toBe('Keep this reply');
	click(app.target, 'Save draft again');
	await until(
		() => !app.folder.tables.drafts.document(id).getSnapshot().isDirty,
		'the retry',
	);
	click(app.target, 'Simulate send failure');
	click(app.target, 'Send demo reply');
	await until(
		() =>
			app
				.conversation('Maya Chen')
				.textContent?.includes('Check send: Keep this reply') === true,
		'uncertain send recovery',
	);
	expect(app.conversation('Maya Chen').textContent).not.toContain('Draft:');
	await until(
		() =>
			[...app.target.querySelectorAll('button')].some(
				(button) =>
					button.textContent?.trim() === 'I checked: keep as draft' &&
					!button.disabled,
			),
		'recovery to become available',
	);
	click(app.target, 'I checked: keep as draft');
	await until(
		() =>
			app
				.conversation('Maya Chen')
				.textContent?.includes('Draft: Keep this reply') === true,
		'the recovered draft',
	);
	await until(
		() =>
			[...app.target.querySelectorAll('button')].some(
				(button) =>
					button.textContent?.trim() === 'Send demo reply' && !button.disabled,
			),
		'the recovered composer',
	);
	click(app.target, 'Send demo reply');
	await until(
		() => app.target.textContent?.includes('Demo message sent.') === true,
		'the accepted reply',
	);
	expect(app.conversation('Maya Chen').textContent).not.toContain('Draft:');
	expect(app.conversation('Maya Chen').textContent).not.toContain(
		'Check send:',
	);
	expect(app.conversation('Maya Chen').textContent).toContain(
		'Keep this reply',
	);
	expect(expectOk(await app.folder.tables.drafts.get(id))?.body).toBe('');
});
