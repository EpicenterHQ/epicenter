/**
 * Messages' send workflow, over a real device folder.
 *
 * The attempt must land before Beeper is asked, an uncertain send needs an
 * explicit check, and the composer's typing after Send stays.
 *
 * Key behaviors:
 * - An uncertain attempt holds its text and blocks resending until checked
 * - Nothing reaches Beeper when the attempt or the draft's clear cannot be saved
 * - Two sends at once reach Beeper once; a stale check cannot undo a newer send
 * - A draft or attempt that does not read, or that names another chat, refuses a send
 * - An attempt on storage the page has not seen refuses a send
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Client, ClientError } from '@epicenter/definition/contract';
import { openDevice } from '@epicenter/folder/node';
import { flushSync } from 'svelte';
import { unwrap } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type Backend, createDemoBackend } from './backend.js';
import { type Messages, messages } from './contract.js';

const { fromClient } = await import('@epicenter/svelte/client');
const { follow } = await import(
	'../../../../packages/svelte/src/reactive.test-support.svelte.js'
);
const { draftId, recoverDraft, sendDraft } = await import('./drafts.js');
type Device = import('./drafts.js').Device;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** A device over a fresh folder, holding an empty draft for Maya's demo chat. */
async function setup(
	wrap: (client: Client<Messages>) => Client<Messages> = (client) => client,
) {
	const root = await mkdtemp(join(tmpdir(), 'messages-drafts-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const client = unwrap(await openDevice(messages, { path: root }));
	const device: Device = { client, files: fromClient(wrap(client)) };
	const backend = createDemoBackend();
	const id = await draftId(backend, 'demo-maya');
	expectOk(
		await device.files.drafts.create({
			id,
			chatId: 'demo-maya',
			profile: backend.profile,
			mode: backend.mode,
		}),
	);
	return { root, device, backend, id };
}

/** Keep `device`'s collections listing and following changes, as an open page does. */
function watch(device: Device) {
	const followed = follow(() => [
		device.files.drafts.items,
		device.files.drafts.invalid,
		device.files.attempts.items,
		device.files.attempts.invalid,
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

const saveDraft = (device: Device, id: string, body: string) =>
	device.files.drafts.update({ id }, { body });
const attemptOf = (device: Device, id: string) =>
	device.files.attempts.get({ id });
const draftOf = (device: Device, id: string) => device.files.drafts.get({ id });

function send(
	device: Device,
	id: string,
	backend: Backend,
	text: string,
	previousAttemptId = attemptOf(device, id)?.attemptId,
	unchanged = () => true,
) {
	return sendDraft(device, {
		id,
		chatId: 'demo-maya',
		backend,
		text,
		previousAttemptId,
		unchanged,
	});
}

function check(
	device: Device,
	id: string,
	backend: Backend,
	checkedAttemptId: string,
	keep = true,
	composerEmpty = () => true,
) {
	return recoverDraft(device, {
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
	const { device, backend, id, root } = await setup();
	const text = 'A draft with Markdown and "quotes".';
	expectOk(await saveDraft(device, id, text));
	backend.failNext();
	expectErr(await send(device, id, backend, text));
	expect(attemptOf(device, id)).toMatchObject({ state: 'sending', body: text });
	expect(draftOf(device, id)?.body).toBe('');
	expect(await readFile(join(root, `attempts/${id}.md`), 'utf8')).toContain(
		'state: sending',
	);
	expectErr(await send(device, id, backend, text));
	expectOk(
		await check(device, id, backend, attemptOf(device, id)?.attemptId ?? ''),
	);
	expect(draftOf(device, id)?.body).toBe(text);
	expect(attemptOf(device, id)?.state).toBe('acknowledged');
	expectOk(await send(device, id, backend, text));
	expect(attemptOf(device, id)?.state).toBe('accepted');
});

test('demo and live drafts use different IDs', async () => {
	const demo = createDemoBackend();
	expect(await draftId(demo, 'same')).not.toBe(
		await draftId({ mode: 'live', profile: demo.profile }, 'same'),
	);
});

test('a failed attempt write never contacts Beeper', async () => {
	const unavailable = ClientError.Unavailable({ cause: 'no disk' });
	const { device, backend, id } = await setup((client) => ({
		...client,
		attempts: {
			...client.attempts,
			create: async () => unavailable,
			update: async () => unavailable,
		},
	}));
	const counted = counting(backend);
	expectOk(await saveDraft(device, id, 'Must not send'));
	expect(
		expectErr(await send(device, id, counted.backend, 'Must not send')).message,
	).toBe('Nothing was sent: the attempt could not be saved.');
	expect(counted.sends).toBe(0);
});

test('two concurrent sends reach Beeper once', async () => {
	const { device, backend, id } = await setup();
	const counted = counting(backend);
	expectOk(await saveDraft(device, id, 'Only once'));
	const [first, second] = await Promise.all([
		send(device, id, counted.backend, 'Only once'),
		send(device, id, counted.backend, 'Only once'),
	]);
	expectOk(first);
	expectErr(second);
	expect(counted.sends).toBe(1);
});

test('typing after Send survives the receipt', async () => {
	const { device, backend, id } = await setup();
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
	expectOk(await saveDraft(device, id, 'First reply'));
	const sending = send(device, id, gated, 'First reply');
	await reached.promise;
	expectOk(await saveDraft(device, id, 'Next reply'));
	release.resolve();
	expectOk(await sending);
	expect(draftOf(device, id)?.body).toBe('Next reply');
	expect(attemptOf(device, id)?.state).toBe('accepted');
});

test('typing after Send is not cleared before Beeper is contacted', async () => {
	const { device, backend, id } = await setup();
	const counted = counting(backend);
	expectOk(await saveDraft(device, id, 'Next reply'));
	expectOk(
		await send(
			device,
			id,
			counted.backend,
			'First reply',
			undefined,
			() => false,
		),
	);
	expect(draftOf(device, id)?.body).toBe('Next reply');
	expect(attemptOf(device, id)?.state).toBe('accepted');
	expect(counted.sends).toBe(1);
});

test('a stale recovery cannot restore an accepted send', async () => {
	const { device, backend, id } = await setup();
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
	expectOk(await saveDraft(device, id, 'One reply'));
	const sending = send(device, id, gated, 'One reply');
	await reached.promise;
	const recovering = check(
		device,
		id,
		gated,
		attemptOf(device, id)?.attemptId ?? '',
	);
	release.resolve();
	expectOk(await sending);
	expectOk(await recovering);
	expect(draftOf(device, id)?.body).toBe('');
	expect(attemptOf(device, id)?.state).toBe('accepted');
	expect(sends).toBe(1);
});

test('checking an older identical attempt cannot acknowledge a newer one', async () => {
	const { device, backend, id } = await setup();
	expectOk(await saveDraft(device, id, 'Same reply'));
	backend.failNext();
	expectErr(await send(device, id, backend, 'Same reply'));
	const oldId = attemptOf(device, id)?.attemptId ?? '';
	expectOk(await check(device, id, backend, oldId));
	backend.failNext();
	expectErr(await send(device, id, backend, 'Same reply'));
	expect(attemptOf(device, id)?.attemptId).not.toBe(oldId);
	expectErr(await check(device, id, backend, oldId));
	expect(attemptOf(device, id)?.state).toBe('sending');
});

test('a failed clear sends nothing and acknowledges the attempt', async () => {
	let failClear = false;
	const { device, backend, id } = await setup((client) => ({
		...client,
		drafts: {
			...client.drafts,
			update: (...args: Parameters<typeof client.drafts.update>) =>
				failClear
					? Promise.resolve(ClientError.Unavailable({ cause: 'no disk' }))
					: client.drafts.update(...args),
		},
	}));
	const counted = counting(backend);
	expectOk(await saveDraft(device, id, 'Prepared reply'));
	failClear = true;
	expect(
		expectErr(await send(device, id, counted.backend, 'Prepared reply'))
			.message,
	).toContain('Nothing was sent');
	expect(counted.sends).toBe(0);
	expect(draftOf(device, id)?.body).toBe('Prepared reply');
	expect(attemptOf(device, id)?.state).toBe('acknowledged');
});

test('broken draft front matter refuses a send', async () => {
	const { device, backend, id, root } = await setup();
	watch(device);
	const counted = counting(backend);
	await writeFile(
		join(root, `drafts/${id}.md`),
		'---\nchatId: [\n---\nOriginal',
	);
	await until(() => device.files.drafts.invalid.some((note) => note.id === id));
	expect(
		expectErr(await send(device, id, counted.backend, 'Edited')).message,
	).toBe('This draft needs Markdown repair before sending.');
	expect(counted.sends).toBe(0);
});

test('an attempt on storage the page has not seen refuses a send', async () => {
	const { device, backend, id, root } = await setup();
	// Nothing follows the page's attempts, so it shows none: another tab's write it has not heard of.
	await Bun.write(
		join(root, `attempts/${id}.md`),
		'---\nstate: sending\n---\nAnother send',
	);
	expect(
		expectErr(await send(device, id, backend, 'Must not send')).message,
	).toContain('Another send');
});

test('an attempt rewritten with a byte-order mark does not block the next send', async () => {
	const { device, backend, id, root } = await setup();
	watch(device);
	expectOk(await saveDraft(device, id, 'First reply'));
	expectOk(await send(device, id, backend, 'First reply'));
	const path = join(root, `attempts/${id}.md`);
	const before = attemptOf(device, id)?.version;
	await writeFile(path, `﻿${await readFile(path, 'utf8')}`);
	await until(() => {
		const shown = attemptOf(device, id);
		return shown !== undefined && shown.version !== before;
	});
	expectOk(await saveDraft(device, id, 'Second reply'));
	expectOk(await send(device, id, backend, 'Second reply'));
});

test('a failed storage read asks to try again', async () => {
	const { device, backend, id } = await setup();
	const unreadable: Device = {
		...device,
		client: {
			...device.client,
			attempts: {
				...device.client.attempts,
				list: async () => ClientError.Unavailable({ cause: 'read failed' }),
			},
		},
	};
	expect(
		expectErr(await send(unreadable, id, backend, 'Must not send')).message,
	).toBe('Could not check storage; try again.');
});

test('a changed draft chatId cannot redirect a send', async () => {
	const { device, backend, id } = await setup();
	const counted = counting(backend);
	expectOk(
		await device.files.drafts.update(
			{ id },
			{ chatId: 'demo-noah', body: 'Private reply' },
		),
	);
	expectErr(await send(device, id, counted.backend, 'Private reply'));
	expect(counted.sends).toBe(0);
});
