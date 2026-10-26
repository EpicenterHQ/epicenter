/**
 * Messages app mounted tests.
 *
 * Saved Markdown supplies conversation previews, while an unresolved attempt
 * takes precedence until the person checks its outcome.
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import {
	createFolder,
	memoryHost,
	SaveError,
	until,
} from '@epicenter/folder/testing';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	click,
	type,
} from '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { createDemoBackend } from './backend.js';
import { messagesTables } from './definition.js';
import { draftId } from './drafts.js';
import { saveDraft, seedDraft } from './drafts.test-support.js';

const { svelteFolder } = await import('@epicenter/svelte/folder');
const { flushSync, mount, unmount } = await import('svelte');
const { default: MessagesApp } = await import('./MessagesApp.svelte');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

async function untilRendered(check: () => boolean, what: string) {
	try {
		await until(
			() => {
				flushSync();
				return check();
			},
			{ timeout: 2000 },
		);
	} catch {
		throw new Error(`Timed out waiting for ${what}`);
	}
}

async function setup() {
	const host = memoryHost();
	const opened = expectOk(
		await createFolder(host.storage, { tables: messagesTables }),
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
		await untilRendered(() => composer() !== null, `${name}'s composer`);
	}
	await untilRendered(
		() => target.textContent?.includes('Maya Chen') === true,
		'conversations',
	);
	return { host, folder, target, conversation, composer, open, close: () => opened.close() };
}

test('a preview follows saved input and disappears when the draft is emptied', async () => {
	const app = await setup();
	await app.open('Maya Chen');
	const id = await draftId(createDemoBackend(), 'demo-maya');
	expect(app.folder.tables.drafts.row(id)).toBeUndefined();
	type(app.composer(), 'Saturday at ten.\nI will bring the address.');
	await untilRendered(
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
	await untilRendered(
		() => !app.conversation('Maya Chen').textContent?.includes('Draft:'),
		'the empty preview',
	);
});

test('sending right after typing saves the reply and clears the composer', async () => {
	const app = await setup();
	await app.open('Maya Chen');
	const id = await draftId(createDemoBackend(), 'demo-maya');
	type(app.composer(), 'Immediate reply');
	click(app.target, 'Send demo reply');
	await untilRendered(
		() => app.target.textContent?.includes('Demo message sent.') === true,
		'the immediate send',
	);
	expect(app.folder.tables.attempts.row(id)?.body).toBe('Immediate reply');
	expect(app.folder.tables.drafts.row(id)?.body).toBe('');
	expect(app.composer()?.value).toBe('');
});

test('sending while the first draft save is in flight uses the landed row', async () => {
	const app = await setup();
	const gate = Promise.withResolvers<void>();
	try {
		await app.open('Maya Chen');
		const id = await draftId(createDemoBackend(), 'demo-maya');
		app.host.control.putGate = gate.promise;
		type(app.composer(), 'Queued reply');
		await untilRendered(
			() => app.host.log.puts.some((put) => put.path === `drafts/${id}.md`),
			'the first draft write',
		);
		click(app.target, 'Send demo reply');
		gate.resolve();
		await untilRendered(
			() => app.target.textContent?.includes('Demo message sent.') === true,
			'the queued send',
		);
		expect(app.folder.tables.attempts.row(id)?.body).toBe('Queued reply');
		expect(app.folder.tables.drafts.row(id)?.body).toBe('');
	} finally {
		gate.resolve();
	}
});

test('typing after Send survives a queued create retry', async () => {
	const app = await setup();
	const gate = Promise.withResolvers<void>();
	try {
		await app.open('Maya Chen');
		const id = await draftId(createDemoBackend(), 'demo-maya');
		app.host.control.putGate = gate.promise;
		type(app.composer(), 'First reply');
		await untilRendered(
			() => app.host.log.puts.some((put) => put.path === `drafts/${id}.md`),
			'the first draft write',
		);
		click(app.target, 'Send demo reply');
		type(app.composer(), 'New reply');
		gate.resolve();
		await untilRendered(
			() => app.target.textContent?.includes('Demo message sent.') === true,
			'the first reply send',
		);
		await untilRendered(
			() => app.folder.tables.drafts.row(id)?.body === 'New reply',
			'the newer reply save',
		);
		expect(app.folder.tables.attempts.row(id)?.body).toBe('First reply');
		expect(app.composer()?.value).toBe('New reply');
	} finally {
		gate.resolve();
	}
});

test('a failed send command shows its outcome beside the composer', async () => {
	const app = await setup();
	await app.open('Maya Chen');
	const id = await draftId(createDemoBackend(), 'demo-maya');
	type(app.composer(), 'Unsent reply');
	await untilRendered(
		() => app.folder.tables.drafts.row(id)?.body === 'Unsent reply',
		'the saved reply',
	);
	app.host.control.failPut.set(
		`attempts/${id}.md`,
		expectErr(SaveError.StorageFailed({ cause: 'no disk' })),
	);
	click(app.target, 'Send demo reply');
	await untilRendered(
		() =>
			app.target.textContent?.includes(
				'Nothing was sent: the attempt could not be saved.',
			) === true,
		'the send failure',
	);
	expect(app.composer()?.value).toBe('Unsent reply');
});

test('reopening a draft does not wait for its previous composer save', async () => {
	const app = await setup();
	const gate = Promise.withResolvers<void>();
	try {
		await app.open('Maya Chen');
		const id = await draftId(createDemoBackend(), 'demo-maya');
		app.host.control.putGate = gate.promise;
		type(app.composer(), 'Still saving');
		await untilRendered(
			() => app.host.log.puts.some((put) => put.path === `drafts/${id}.md`),
			'the draft write',
		);
		await app.open('Community garden');
		app.conversation('Maya Chen').click();
		flushSync();
		expect(app.composer()).not.toBeNull();
		gate.resolve();
		await untilRendered(
			() => app.composer()?.value === 'Still saving',
			'the reopened composer',
		);
	} finally {
		gate.resolve();
	}
});

test('typing during a save keeps the newest reply', async () => {
	const app = await setup();
	const gate = Promise.withResolvers<void>();
	try {
		await app.open('Maya Chen');
		const id = await draftId(createDemoBackend(), 'demo-maya');
		app.host.control.putGate = gate.promise;
		type(app.composer(), 'First');
		await untilRendered(
			() => app.host.log.puts.some((put) => put.path === `drafts/${id}.md`),
			'the first draft write',
		);
		type(app.composer(), 'First and second');
		flushSync();
		expect(app.composer()?.value).toBe('First and second');
		gate.resolve();
		await untilRendered(
			() => app.folder.tables.drafts.row(id)?.body === 'First and second',
			'the newest reply',
		);
		expect(app.composer()?.value).toBe('First and second');
	} finally {
		gate.resolve();
	}
});

test('closing a missing draft waits for the newest typed reply', async () => {
	const app = await setup();
	const gate = Promise.withResolvers<void>();
	try {
		await app.open('Maya Chen');
		const id = await draftId(createDemoBackend(), 'demo-maya');
		app.host.control.putGate = gate.promise;
		type(app.composer(), 'First');
		await untilRendered(
			() => app.host.log.puts.some((put) => put.path === `drafts/${id}.md`),
			'the first draft write',
		);
		type(app.composer(), 'Newest');
		const idle = app.folder.idle();
		const close = app.close();
		gate.resolve();
		await idle;
		await close;
		expect(app.host.text(`drafts/${id}.md`)).toContain('Newest');
	} finally {
		gate.resolve();
	}
});

test('failed draft saves retain text for retry or discard', async () => {
	const app = await setup();
	await app.open('Maya Chen');
	const id = await draftId(createDemoBackend(), 'demo-maya');
	const path = `drafts/${id}.md`;
	app.host.control.failPut.set(
		path,
		expectErr(SaveError.StorageFailed({ cause: 'no disk' })),
	);
	type(app.composer(), 'Keep this text');
	flushSync();
	expect(app.composer()?.value).toBe('Keep this text');
	await untilRendered(
		() => app.target.textContent?.includes('Not saved:') === true,
		'the failed draft notice',
	);
	expect(app.composer()?.value).toBe('Keep this text');
	expect(app.folder.tables.drafts.row(id)).toBeUndefined();
	app.host.control.failPut.delete(path);
	click(app.target, 'Save again');
	await untilRendered(
		() => app.folder.tables.drafts.row(id)?.body === 'Keep this text',
		'the retried draft',
	);
	await untilRendered(
		() => !app.target.textContent?.includes('Not saved:'),
		'the cleared error',
	);

	app.host.control.failPut.set(
		path,
		expectErr(SaveError.StorageFailed({ cause: 'no disk' })),
	);
	type(app.composer(), 'Discard this change');
	await untilRendered(
		() => app.target.textContent?.includes('Not saved:') === true,
		'the second failed save',
	);
	expect(app.composer()?.value).toBe('Discard this change');
	click(app.target, 'Discard');
	flushSync();
	expect(app.composer()?.value).toBe('Keep this text');
});

test('sending a failed draft save waits for an explicit retry', async () => {
	const app = await setup();
	await app.open('Maya Chen');
	const id = await draftId(createDemoBackend(), 'demo-maya');
	const path = `drafts/${id}.md`;
	app.host.control.failPut.set(
		path,
		expectErr(SaveError.StorageFailed({ cause: 'no disk' })),
	);
	type(app.composer(), 'Retry this reply');
	await untilRendered(
		() => app.target.textContent?.includes('Not saved:') === true,
		'the failed draft notice',
	);
	click(app.target, 'Send demo reply');
	await untilRendered(
		() =>
			app.target.textContent?.includes(
				'Nothing was sent: the draft could not be saved.',
			) === true,
		'the refused send',
	);
	expect(app.folder.tables.attempts.row(id)).toBeUndefined();
	expect(app.composer()?.value).toBe('Retry this reply');
	app.host.control.failPut.delete(path);
	click(app.target, 'Save again');
	await untilRendered(
		() => app.folder.tables.drafts.row(id)?.body === 'Retry this reply',
		'the retried draft',
	);
	click(app.target, 'Send demo reply');
	await untilRendered(
		() => app.target.textContent?.includes('Demo message sent.') === true,
		'the accepted send',
	);
	expect(app.folder.tables.attempts.row(id)?.body).toBe('Retry this reply');
	expect(app.composer()?.value).toBe('');
});

test('typing recreates a draft deleted outside the app', async () => {
	const app = await setup();
	await app.open('Maya Chen');
	const id = await draftId(createDemoBackend(), 'demo-maya');
	type(app.composer(), 'First reply');
	await untilRendered(
		() => app.folder.tables.drafts.row(id)?.body === 'First reply',
		'the first draft save',
	);
	app.host.outside(`drafts/${id}.md`, null);
	await app.folder.refresh();
	await untilRendered(
		() => app.folder.tables.drafts.row(id) === undefined,
		'the outside deletion',
	);
	type(app.composer(), 'Recreated reply');
	await untilRendered(
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
	await untilRendered(
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
	await app.folder.refresh();
	await untilRendered(
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
	await untilRendered(
		() =>
			app
				.conversation('Maya Chen')
				.textContent?.includes('Draft: Keep this reply') === true,
		'the draft',
	);
	click(app.target, 'Simulate send failure');
	click(app.target, 'Send demo reply');
	await untilRendered(
		() =>
			app
				.conversation('Maya Chen')
				.textContent?.includes('Check send: Keep this reply') === true,
		'uncertain attempt',
	);
	expect(app.conversation('Maya Chen').textContent).not.toContain('Draft:');
	click(app.target, 'I checked: keep as draft');
	await untilRendered(
		() =>
			app
				.conversation('Maya Chen')
				.textContent?.includes('Draft: Keep this reply') === true,
		'recovered draft',
	);
	click(app.target, 'Send demo reply');
	await untilRendered(
		() => app.target.textContent?.includes('Demo message sent.') === true,
		'accepted send',
	);
	expect(app.conversation('Maya Chen').textContent).not.toContain(
		'Check send:',
	);
});
