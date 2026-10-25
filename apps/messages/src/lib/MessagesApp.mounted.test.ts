/**
 * Messages app mounted tests.
 *
 * Saved Markdown supplies conversation previews, while an unresolved attempt
 * takes precedence until the person checks its outcome.
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { createFolder, memoryHost } from '@epicenter/folder/next/testing';
import { expectOk } from 'wellcrafted/testing';
import {
	click,
	type,
} from '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { createDemoBackend } from './backend.js';
import { messagesTables } from './definition.js';
import { draftId } from './drafts.js';
import { saveDraft, seedDraft } from './drafts.test-support.js';

const { svelteFolder } = await import('@epicenter/svelte/folder-next');
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

async function setup() {
	const host = memoryHost();
	const opened = expectOk(
		await createFolder(host.storage, { tables: messagesTables, throttleMs: 0 }),
	);
	const folder = svelteFolder(opened);
	const target = document.createElement('main');
	document.body.append(target);
	const app = mount(MessagesApp, { target, props: { folder } });
	cleanups.push(async () => {
		await unmount(app);
		await opened.close();
		target.remove();
	});
	function conversation(name: string) {
		const row = [
			...target.querySelectorAll<HTMLButtonElement>(
				'[aria-label="Conversations"] button',
			),
		].find((button) => button.textContent?.includes(name));
		if (!row) throw new Error(`No conversation named ${name}`);
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
	return { host, folder, target, conversation, composer, open };
}

test('a preview follows saved input and disappears when the draft is emptied', async () => {
	const app = await setup();
	await app.open('Maya Chen');
	const id = await draftId(createDemoBackend(), 'demo-maya');
	expect(app.folder.tables.drafts.row(id)).toBeUndefined();
	type(app.composer(), 'Saturday at ten.\nI will bring the address.');
	await until(
		() =>
			app
				.conversation('Maya Chen')
				.textContent?.includes(
					'Draft: Saturday at ten. I will bring the address.',
				) === true,
		'the saved preview',
	);
	expect(app.folder.tables.drafts.row(id)?.body).toBe(
		'Saturday at ten.\nI will bring the address.',
	);
	await app.open('Community garden');
	expect(app.composer()?.value).toBe('');
	await app.open('Maya Chen');
	expect(app.composer()?.value).toBe(
		'Saturday at ten.\nI will bring the address.',
	);
	type(app.composer(), ' ');
	await until(
		() => !app.conversation('Maya Chen').textContent?.includes('Draft:'),
		'the empty preview',
	);
});

test('reopening a draft waits for its previous composer save', async () => {
	const app = await setup();
	const gate = Promise.withResolvers<void>();
	try {
		await app.open('Maya Chen');
		const id = await draftId(createDemoBackend(), 'demo-maya');
		app.host.control.putGate = gate.promise;
		type(app.composer(), 'Still saving');
		await until(
			() => app.host.log.puts.some((put) => put.path === `drafts/${id}.md`),
			'the draft write',
		);
		await app.open('Community garden');
		app.conversation('Maya Chen').click();
		flushSync();
		expect(app.composer()).toBeNull();
		gate.resolve();
		await until(
			() => app.composer()?.value === 'Still saving',
			'the reopened composer',
		);
	} finally {
		gate.resolve();
	}
});

test('typing recreates a draft deleted outside the app', async () => {
	const app = await setup();
	await app.open('Maya Chen');
	const id = await draftId(createDemoBackend(), 'demo-maya');
	type(app.composer(), 'First reply');
	await until(
		() => app.folder.tables.drafts.row(id)?.body === 'First reply',
		'the first draft save',
	);
	app.host.outside(`drafts/${id}.md`, null);
	app.folder.checkpoint();
	await until(
		() => app.folder.tables.drafts.row(id) === undefined,
		'the outside deletion',
	);
	type(app.composer(), 'Recreated reply');
	await until(
		() => app.folder.tables.drafts.row(id)?.body === 'Recreated reply',
		'the recreated draft',
	);
});

test('saved previews stay within their mode and profile', async () => {
	const app = await setup();
	const demo = createDemoBackend();
	const maya = await seedDraft(app.folder, demo, 'demo-maya');
	expectOk(await saveDraft(app.folder, maya.id, { body: 'Saved in Markdown' }));
	const live = await seedDraft(
		app.folder,
		{ ...demo, mode: 'live' },
		'demo-garden',
	);
	expectOk(
		await saveDraft(app.folder, live.id, { body: 'Live private draft' }),
	);
	const other = await seedDraft(
		app.folder,
		{ ...demo, profile: 'another-account' },
		'demo-noah',
	);
	expectOk(
		await saveDraft(app.folder, other.id, { body: 'Another account draft' }),
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
		'Another account draft',
	);
	expect(app.composer()).toBeNull();
	app.host.outside(
		`drafts/${maya.id}.md`,
		(app.host.text(`drafts/${maya.id}.md`) ?? '').replace(
			'Saved in Markdown',
			'Changed outside Messages',
		),
	);
	app.folder.checkpoint();
	await until(
		() =>
			app
				.conversation('Maya Chen')
				.textContent?.includes('Draft: Changed outside Messages') === true,
		'the outside edit',
	);
});

test('an uncertain send shows Check send and checked recovery restores Draft', async () => {
	const app = await setup();
	await app.open('Maya Chen');
	type(app.composer(), 'Keep this reply');
	await until(
		() =>
			app
				.conversation('Maya Chen')
				.textContent?.includes('Draft: Keep this reply') === true,
		'the draft',
	);
	click(app.target, 'Simulate send failure');
	click(app.target, 'Send demo reply');
	await until(
		() =>
			app
				.conversation('Maya Chen')
				.textContent?.includes('Check send: Keep this reply') === true,
		'uncertain attempt',
	);
	expect(app.conversation('Maya Chen').textContent).not.toContain('Draft:');
	click(app.target, 'I checked: keep as draft');
	await until(
		() =>
			app
				.conversation('Maya Chen')
				.textContent?.includes('Draft: Keep this reply') === true,
		'recovered draft',
	);
	click(app.target, 'Send demo reply');
	await until(
		() => app.target.textContent?.includes('Demo message sent.') === true,
		'accepted send',
	);
	expect(app.conversation('Maya Chen').textContent).not.toContain(
		'Check send:',
	);
});
