/**
 * Messages' send workflow, over a folder in memory (the page's is this
 * browser's files): another tab's write is a file written at the same place
 * (`memoryFiles`), and storage out of reach is one the place refuses, so
 * the folder's writes there wait.
 *
 * The attempt must land before Beeper is asked, an uncertain send needs an
 * explicit check, and the composer's typing after Send stays.
 *
 * Key behaviors:
 * - An uncertain attempt holds its text and blocks resending until checked
 * - Nothing reaches Beeper until the attempt and the draft's clear land
 * - Two sends at once reach Beeper once; a stale check cannot undo a newer send
 * - A draft or attempt that does not read, or that names another chat, refuses a send
 * - An attempt on storage the page has not seen refuses a send
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder';
import type { Folder } from '@epicenter/folder/core';
import { memory, memoryFiles } from '@epicenter/folder/memory';
import { flushSync } from 'svelte';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type Backend, createDemoBackend } from './backend.js';
import { type Messages, messages } from './contract.js';

// Bun has no Web Locks: a lock per name, granted in the order asked, as a browser grants it.
if (!('locks' in navigator)) {
	const held = new Map<string, Promise<unknown>>();
	Object.defineProperty(navigator, 'locks', {
		value: {
			request(name: string, action: () => Promise<unknown>) {
				const turn = (held.get(name) ?? Promise.resolve())
					.catch(() => {})
					.then(action);
				held.set(name, turn);
				return turn;
			},
		},
	});
}

const { reactive } = await import('@epicenter/svelte/reactive');
const { follow } = await import(
	'../../../../packages/svelte/src/reactive.test-support.svelte.js'
);
const { draftId, recoverDraft, sendDraft } = await import('./drafts.js');

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/**
 * A folder at a new place in memory, read through `reactive` as the page
 * reads its own, holding an empty draft for Maya's demo chat. `files` is the
 * place as another tab writes it, and refuses the folder's writes or reads
 * below a directory.
 */
async function setup() {
	const place = memory();
	const files = memoryFiles(place);
	const folder: Folder<Messages> = reactive(openFolder(messages, place));
	cleanup.push(() => folder[Symbol.dispose]());
	const backend = createDemoBackend();
	const id = await draftId(backend, 'demo-maya');
	await folder.drafts.set(
		{ id },
		{ chatId: 'demo-maya', profile: backend.profile, mode: backend.mode },
	);
	return { files, folder, backend, id };
}

/** Keep `folder`'s collections listing and following changes, as an open page does. */
function watch(folder: Folder<Messages>) {
	const followed = follow(() => [
		folder.drafts.items(),
		folder.drafts.invalid(),
		folder.attempts.items(),
		folder.attempts.invalid(),
	]);
	cleanup.push(followed.stop);
}

async function until(check: () => boolean) {
	for (let turn = 0; turn < 400 && !check(); turn++) {
		await Bun.sleep(5);
		flushSync();
	}
	expect(check()).toBe(true);
}

const saveDraft = (folder: Folder<Messages>, id: string, body: string) =>
	folder.drafts.set({ id }, { body });
const attemptOf = (folder: Folder<Messages>, id: string) =>
	folder.attempts.get({ id });
const draftOf = (folder: Folder<Messages>, id: string) =>
	folder.drafts.get({ id });

function send(
	folder: Folder<Messages>,
	id: string,
	backend: Backend,
	text: string,
	previousAttemptId = attemptOf(folder, id)?.attemptId,
	unchanged = () => true,
) {
	return sendDraft(folder, {
		id,
		chatId: 'demo-maya',
		backend,
		text,
		previousAttemptId,
		unchanged,
	});
}

function check(
	folder: Folder<Messages>,
	id: string,
	backend: Backend,
	checkedAttemptId: string,
	keep = true,
	composerEmpty = () => true,
) {
	return recoverDraft(folder, {
		id,
		chatId: 'demo-maya',
		backend,
		checkedAttemptId,
		keep,
		composerEmpty,
	});
}

/** `backend`, counting the sends that reach it. */
function counting(backend: Backend) {
	const counted = {
		sends: 0,
		backend: {
			...backend,
			request(request) {
				if (request.action === 'send') counted.sends++;
				return backend.request(request);
			},
		} satisfies Backend,
	};
	return counted;
}

test('an uncertain attempt holds its text and blocks resending until checked', async () => {
	const { folder, backend, id, files } = await setup();
	const text = 'A draft with Markdown and "quotes".';
	await saveDraft(folder, id, text);
	backend.failNext();
	expectErr(await send(folder, id, backend, text));
	expect(attemptOf(folder, id)).toMatchObject({ state: 'sending', body: text });
	expect(draftOf(folder, id)?.body).toBe('');
	expect(files.read(`attempts/${id}.md`)).toContain('state: sending');
	expectErr(await send(folder, id, backend, text));
	expectOk(
		await check(folder, id, backend, attemptOf(folder, id)?.attemptId ?? ''),
	);
	expect(draftOf(folder, id)?.body).toBe(text);
	expect(attemptOf(folder, id)?.state).toBe('acknowledged');
	expectOk(await send(folder, id, backend, text));
	expect(attemptOf(folder, id)?.state).toBe('accepted');
});

test('demo and live drafts use different IDs', async () => {
	const demo = createDemoBackend();
	expect(await draftId(demo, 'same')).not.toBe(
		await draftId({ mode: 'live', profile: demo.profile }, 'same'),
	);
});

test('Beeper is not asked until the attempt lands', async () => {
	const { folder, backend, id, files } = await setup();
	const counted = counting(backend);
	await saveDraft(folder, id, 'Once it lands');
	const undo = files.refuse('no disk', { under: 'attempts' });
	const sending = send(folder, id, counted.backend, 'Once it lands');
	await until(() => folder.saving() && folder.unavailable() !== null);
	await Bun.sleep(20);
	expect(counted.sends).toBe(0);
	expect(files.read(`attempts/${id}.md`)).toBeNull();
	undo();
	expectOk(await sending);
	expect(counted.sends).toBe(1);
	expect(attemptOf(folder, id)?.state).toBe('accepted');
});

test('two concurrent sends reach Beeper once', async () => {
	const { folder, backend, id } = await setup();
	const counted = counting(backend);
	await saveDraft(folder, id, 'Only once');
	const [first, second] = await Promise.all([
		send(folder, id, counted.backend, 'Only once'),
		send(folder, id, counted.backend, 'Only once'),
	]);
	expectOk(first);
	expectErr(second);
	expect(counted.sends).toBe(1);
});

test('typing after Send survives the receipt', async () => {
	const { folder, backend, id } = await setup();
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const gated: Backend = {
		...backend,
		async request(request) {
			if (request.action === 'send') {
				reached.resolve();
				await release.promise;
			}
			return backend.request(request);
		},
	};
	await saveDraft(folder, id, 'First reply');
	const sending = send(folder, id, gated, 'First reply');
	await reached.promise;
	await saveDraft(folder, id, 'Next reply');
	release.resolve();
	expectOk(await sending);
	expect(draftOf(folder, id)?.body).toBe('Next reply');
	expect(attemptOf(folder, id)?.state).toBe('accepted');
});

test('typing after Send is not cleared before Beeper is contacted', async () => {
	const { folder, backend, id } = await setup();
	const counted = counting(backend);
	await saveDraft(folder, id, 'Next reply');
	expectOk(
		await send(
			folder,
			id,
			counted.backend,
			'First reply',
			undefined,
			() => false,
		),
	);
	expect(draftOf(folder, id)?.body).toBe('Next reply');
	expect(attemptOf(folder, id)?.state).toBe('accepted');
	expect(counted.sends).toBe(1);
});

test('a stale recovery cannot restore an accepted send', async () => {
	const { folder, backend, id } = await setup();
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let sends = 0;
	const gated: Backend = {
		...backend,
		async request(request) {
			if (request.action === 'send') {
				sends++;
				reached.resolve();
				await release.promise;
			}
			return backend.request(request);
		},
	};
	await saveDraft(folder, id, 'One reply');
	const sending = send(folder, id, gated, 'One reply');
	await reached.promise;
	const recovering = check(
		folder,
		id,
		gated,
		attemptOf(folder, id)?.attemptId ?? '',
	);
	release.resolve();
	expectOk(await sending);
	expectOk(await recovering);
	expect(draftOf(folder, id)?.body).toBe('');
	expect(attemptOf(folder, id)?.state).toBe('accepted');
	expect(sends).toBe(1);
});

test('checking an older identical attempt cannot acknowledge a newer one', async () => {
	const { folder, backend, id } = await setup();
	await saveDraft(folder, id, 'Same reply');
	backend.failNext();
	expectErr(await send(folder, id, backend, 'Same reply'));
	const oldId = attemptOf(folder, id)?.attemptId ?? '';
	expectOk(await check(folder, id, backend, oldId));
	backend.failNext();
	expectErr(await send(folder, id, backend, 'Same reply'));
	expect(attemptOf(folder, id)?.attemptId).not.toBe(oldId);
	expectErr(await check(folder, id, backend, oldId));
	expect(attemptOf(folder, id)?.state).toBe('sending');
});

test('Beeper is not asked until the draft’s clear lands', async () => {
	const { folder, backend, id, files } = await setup();
	const counted = counting(backend);
	await saveDraft(folder, id, 'Prepared reply');
	const undo = files.refuse('no disk', { under: 'drafts' });
	const sending = send(folder, id, counted.backend, 'Prepared reply');
	await until(() => attemptOf(folder, id)?.state === 'sending');
	await until(() => folder.unavailable() !== null);
	await Bun.sleep(20);
	expect(counted.sends).toBe(0);
	expect(draftOf(folder, id)?.body).toBe('Prepared reply');
	undo();
	expectOk(await sending);
	expect(counted.sends).toBe(1);
	expect(draftOf(folder, id)?.body).toBe('');
	expect(attemptOf(folder, id)?.state).toBe('accepted');
});

test('broken draft front matter refuses a send', async () => {
	const { folder, backend, id, files } = await setup();
	watch(folder);
	const counted = counting(backend);
	await files.write(`drafts/${id}.md`, '---\nchatId: [\n---\nOriginal');
	await until(() => folder.drafts.invalid().some((note) => note.id === id));
	expect(
		expectErr(await send(folder, id, counted.backend, 'Edited')).message,
	).toBe('This draft needs Markdown repair before sending.');
	expect(counted.sends).toBe(0);
});

test('an attempt on storage the page has not seen refuses a send', async () => {
	const { folder, backend, id, files } = await setup();
	// Nothing follows the page's attempts, so it shows none: another tab's send it has not heard of.
	await files.write(
		`attempts/${id}.md`,
		`---\nchatId: demo-maya\nprofile: ${backend.profile}\nmode: demo\nstate: accepted\nattemptId: other\npendingId: p1\n---\nSent from another tab`,
	);
	expect(
		expectErr(await send(folder, id, backend, 'Must not send')).message,
	).toContain('Another send');
});

test('an attempt rewritten with a byte-order mark does not block the next send', async () => {
	const { folder, backend, id, files } = await setup();
	watch(folder);
	await saveDraft(folder, id, 'First reply');
	expectOk(await send(folder, id, backend, 'First reply'));
	const path = `attempts/${id}.md`;
	await files.write(path, `﻿${files.read(path)}`);
	await saveDraft(folder, id, 'Second reply');
	expectOk(await send(folder, id, backend, 'Second reply'));
});

test('a failed storage read asks to try again', async () => {
	const { folder, backend, id, files } = await setup();
	files.refuseReads('read failed', { under: 'attempts' });
	expect(
		expectErr(await send(folder, id, backend, 'Must not send')).message,
	).toBe('Could not check storage; try again.');
});

test('a changed draft chatId cannot redirect a send', async () => {
	const { folder, backend, id } = await setup();
	const counted = counting(backend);
	await folder.drafts.set(
		{ id },
		{ chatId: 'demo-noah', body: 'Private reply' },
	);
	expectErr(await send(folder, id, counted.backend, 'Private reply'));
	expect(counted.sends).toBe(0);
});
