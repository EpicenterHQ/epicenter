/** Real scratch folders preserve draft text and fence uncertain sends across reopening. No live Beeper data. */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFolder } from '@epicenter/folder/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type Backend, createDemoBackend } from './backend.js';
import { messagesTables } from './definition.js';
import { draftId, openDraft, sendDraft } from './drafts.js';
import { FileError } from '../../../../packages/folder/src/errors.js';
import { createNativeFolder } from '../../../../packages/folder/src/native/engine.js';
import { nativeStorage } from '../../../../packages/folder/src/native/storage.js';

test('a send without confirmation retains text and cannot repeat after reopening', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-messages-test-'));
	const backend = createDemoBackend();
	let folder = expectOk(
		await openFolder({ directory, tables: messagesTables }),
	);
	try {
		const draft = expectOk(await openDraft(folder, backend, 'demo-maya'));
		const text = '---\nA draft with Markdown and "quotes".\n';
		expectOk(
			await folder.tables.drafts.set(draft.id, draft.row, { body: text }),
		);
		backend.failNext();
		expectErr(await sendDraft(folder, 'demo-maya', backend));
		let row = expectOk(await folder.tables.drafts.get(draft.id));
		expect(row?.body).toBe(text);
		expect(row?.fields?.state).toBe('sending');
		await folder.close();
		folder = expectOk(await openFolder({ directory, tables: messagesTables }));
		expectErr(await sendDraft(folder, 'demo-maya', backend));
		row = expectOk(await folder.tables.drafts.get(draft.id));
		expect(row?.body).toBe(text);
		expectOk(
			await folder.tables.drafts.set(draft.id, row ?? null, {
				fields: { state: 'draft' },
			}),
		);
		expectOk(await sendDraft(folder, 'demo-maya', backend));
		row = expectOk(await folder.tables.drafts.get(draft.id));
		expect(row?.fields?.state).toBe('accepted');
		expect(row?.body).toBe('');
		expectErr(await sendDraft(folder, 'demo-maya', backend));
	} finally {
		await folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('demo and live drafts never share IDs and a held composer is saved before sending', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-messages-test-'));
	const backend = createDemoBackend();
	const folder = expectOk(
		await openFolder({ directory, tables: messagesTables }),
	);
	try {
		expect(await draftId(backend, 'same')).not.toBe(
			await draftId({ mode: 'live', profile: backend.profile }, 'same'),
		);
		const draft = expectOk(await openDraft(folder, backend, 'demo-maya'));
		const edit = folder.tables.drafts.edit(draft.id);
		expectOk(edit.change({ body: 'Accepted input not saved yet' }));
		expectOk(await sendDraft(folder, 'demo-maya', backend));
		const answer = await backend.request({
			action: 'messages',
			chatId: 'demo-maya',
		});
		if (answer.kind !== 'messages')
			throw new Error('Could not read demo messages');
		expect(answer.page.items.at(-1)?.text).toBe('Accepted input not saved yet');
	} finally {
		await folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('a storage failure before the durable send fence prevents any backend send', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-messages-test-'));
	const demo = createDemoBackend();
	let sends = 0;
	const backend: Backend = {
		...demo,
		async request(request) {
			if (request.action === 'send') sends++;
			return demo.request(request);
		},
	};
	const storage = nativeStorage(directory);
	let refuseWrites = false;
	const folder = createNativeFolder({
		directory: `bun:${directory}`,
		tables: messagesTables,
		storage: {
			...storage,
			put: (path, bytes, ifMatch) =>
				refuseWrites
					? Promise.resolve(FileError.Io({
						path,
						operation: 'write',
						cause: new Error('Simulated disk failure'),
					}))
					: storage.put(path, bytes, ifMatch),
		},
	});
	try {
		const draft = expectOk(await openDraft(folder, backend, 'demo-maya'));
		expectOk(
			await folder.tables.drafts.set(draft.id, draft.row, {
				body: 'Must not send',
			}),
		);
		refuseWrites = true;
		expectErr(await sendDraft(folder, 'demo-maya', backend));
		expect(sends).toBe(0);
	} finally {
		await folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('editing a draft destination cannot redirect a reply away from the displayed chat', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-messages-test-'));
	const backend = createDemoBackend();
	const folder = expectOk(
		await openFolder({ directory, tables: messagesTables }),
	);
	try {
		const draft = expectOk(await openDraft(folder, backend, 'demo-maya'));
		expectOk(
			await folder.tables.drafts.set(draft.id, draft.row, {
				fields: { chatId: 'demo-noah' },
				body: 'Private reply for Maya',
			}),
		);
		expectErr(await sendDraft(folder, 'demo-maya', backend));
		for (const chatId of ['demo-maya', 'demo-noah']) {
			const answer = await backend.request({ action: 'messages', chatId });
			if (answer.kind !== 'messages')
				throw new Error('Could not read demo chat');
			expect(
				answer.page.items.some(
					(message) => message.text === 'Private reply for Maya',
				),
			).toBe(false);
		}
	} finally {
		await folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});


test('an admitted send saves its receipt after close starts during the backend reply', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-messages-test-'));
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const demo = createDemoBackend();
	const backend: Backend = {
		...demo,
		async request(request) {
			if (request.action === 'send') {
				reached.resolve();
				await release.promise;
			}
			return demo.request(request);
		},
	};
	const folder = expectOk(await openFolder({ directory, tables: messagesTables }));
	try {
		const draft = expectOk(await openDraft(folder, backend, 'demo-maya'));
		expectOk(await folder.tables.drafts.set(draft.id, draft.row, { body: 'Sent during close' }));
		const sending = sendDraft(folder, 'demo-maya', backend);
		await reached.promise;
		let closed = false;
		const closing = folder.close().then(() => { closed = true; });
		expect(folder.getStatus().closing).toBe(true);
		expectErr(await openDraft(folder, backend, 'demo-noah'));
		expect(closed).toBe(false);
		release.resolve();
		expectOk(await sending);
		await closing;
		const reopened = expectOk(await openFolder({ directory, tables: messagesTables }));
		try {
			const receipt = expectOk(await reopened.tables.drafts.get(draft.id));
			expect(receipt?.fields?.state).toBe('accepted');
			expect(receipt?.fields?.pendingId).not.toBe('');
			expect(receipt?.body).toBe('');
		} finally {
			await reopened.close();
		}
	} finally {
		release.resolve();
		await folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('draft opening and sending are admitted before their hash awaits', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-messages-test-'));
	const backend = createDemoBackend();
	let folder = expectOk(await openFolder({ directory, tables: messagesTables }));
	try {
		const opening = openDraft(folder, backend, 'demo-maya');
		const closing = folder.close();
		const draft = expectOk(await opening);
		await closing;
		folder = expectOk(await openFolder({ directory, tables: messagesTables }));
		expectOk(await folder.tables.drafts.set(draft.id, draft.row, { body: 'Entered before hash' }));
		const sending = sendDraft(folder, 'demo-maya', backend);
		const closingSend = folder.close();
		expectOk(await sending);
		await closingSend;
	} finally {
		await folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});
