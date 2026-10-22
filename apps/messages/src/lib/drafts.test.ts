/** Real scratch folders preserve draft text and fence uncertain sends across reopening. No live Beeper data. */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFolder } from '@epicenter/folder/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type Backend, createDemoBackend } from './backend.js';
import { messagesTables } from './definition.js';
import {
	type CheckedAttempt,
	draftId,
	type MessagesFolder,
	recoverDraft,
	sendDraft,
} from './drafts.js';
import { seedDraft } from './drafts.test-support.js';

async function checkedAttempt(
	folder: MessagesFolder,
	id: string,
): Promise<CheckedAttempt> {
	const attempt = expectOk(await folder.tables.attempts.get(id));
	if (attempt?.issues === null) return { attemptId: attempt.fields.attemptId };
	const draft = expectOk(await folder.tables.drafts.get(id));
	if (!draft) throw new Error('No displayed attempt');
	return { legacyText: draft.text };
}

import { FileError } from '../../../../packages/folder/src/errors.js';
import { createNativeFolder } from '../../../../packages/folder/src/native/engine.js';
import { nativeStorage } from '../../../../packages/folder/src/native/storage.js';

test('an uncertain attempt retains sent text separately and cannot repeat after reopening', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-messages-test-'));
	const backend = createDemoBackend();
	let folder = expectOk(
		await openFolder({ directory, tables: messagesTables }),
	);
	try {
		const draft = await seedDraft(folder, backend, 'demo-maya');
		const text = '---\nA draft with Markdown and "quotes".\n';
		expectOk(await folder.tables.drafts.set(draft.id, { body: text }));
		backend.failNext();
		expectErr(await sendDraft(folder, draft.id, 'demo-maya', backend));
		expect(expectOk(await folder.tables.attempts.get(draft.id))?.body).toBe(
			text,
		);
		expect(expectOk(await folder.tables.drafts.get(draft.id))?.body).toBe('');
		await folder.close();
		folder = expectOk(await openFolder({ directory, tables: messagesTables }));
		expectErr(await sendDraft(folder, draft.id, 'demo-maya', backend));
		expectOk(
			await recoverDraft(
				folder,
				draft.id,
				'demo-maya',
				backend,
				await checkedAttempt(folder, draft.id),
				true,
			),
		);
		expect(expectOk(await folder.tables.drafts.get(draft.id))?.body).toBe(text);
		expectOk(await sendDraft(folder, draft.id, 'demo-maya', backend));
		expect(
			expectOk(await folder.tables.attempts.get(draft.id))?.fields?.state,
		).toBe('accepted');
		expect(expectOk(await folder.tables.drafts.get(draft.id))?.body).toBe('');
		expectErr(await sendDraft(folder, draft.id, 'demo-maya', backend));
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
		const draft = await seedDraft(folder, backend, 'demo-maya');
		const edit = folder.tables.drafts.edit(draft.id);
		expectOk(edit.change({ body: 'Accepted input not saved yet' }));
		expectOk(await sendDraft(folder, draft.id, 'demo-maya', backend));
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
					? Promise.resolve(
							FileError.Io({
								path,
								operation: 'write',
								cause: new Error('Simulated disk failure'),
							}),
						)
					: storage.put(path, bytes, ifMatch),
		},
	});
	try {
		const draft = await seedDraft(folder, backend, 'demo-maya');
		expectOk(
			await folder.tables.drafts.set(draft.id, {
				body: 'Must not send',
			}),
		);
		refuseWrites = true;
		expectErr(await sendDraft(folder, draft.id, 'demo-maya', backend));
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
		const draft = await seedDraft(folder, backend, 'demo-maya');
		expectOk(
			await folder.tables.drafts.set(draft.id, {
				fields: { chatId: 'demo-noah' },
				body: 'Private reply for Maya',
			}),
		);
		expectErr(await sendDraft(folder, draft.id, 'demo-maya', backend));
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
	const folder = expectOk(
		await openFolder({ directory, tables: messagesTables }),
	);
	try {
		const draft = await seedDraft(folder, backend, 'demo-maya');
		expectOk(
			await folder.tables.drafts.set(draft.id, {
				body: 'Sent during close',
			}),
		);
		const sending = sendDraft(folder, draft.id, 'demo-maya', backend);
		await reached.promise;
		let closed = false;
		const closing = folder.close().then(() => {
			closed = true;
		});
		expect(folder.getStatus().closing).toBe(true);
		expectErr(await sendDraft(folder, 'closed', 'demo-noah', backend));
		expect(closed).toBe(false);
		release.resolve();
		expectOk(await sending);
		await closing;
		const reopened = expectOk(
			await openFolder({ directory, tables: messagesTables }),
		);
		try {
			const receipt = expectOk(await reopened.tables.attempts.get(draft.id));
			expect(receipt?.fields?.state).toBe('accepted');
			expect(receipt?.fields?.pendingId).not.toBe('');
			expect(receipt?.body).toBe('Sent during close');
		} finally {
			await reopened.close();
		}
	} finally {
		release.resolve();
		await folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('two sends of one draft at once reach the backend once', async () => {
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
	const folder = expectOk(
		await openFolder({ directory, tables: messagesTables }),
	);
	try {
		const draft = await seedDraft(folder, backend, 'demo-maya');
		expectOk(
			await folder.tables.drafts.set(draft.id, {
				body: 'Only once',
			}),
		);
		const [first, second] = await Promise.all([
			sendDraft(folder, draft.id, 'demo-maya', backend),
			sendDraft(folder, draft.id, 'demo-maya', backend),
		]);
		expectOk(first);
		expect(expectErr(second).name).toBe('Refused');
		expect(sends).toBe(1);
	} finally {
		await folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('sending is admitted when called, before close', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-messages-test-'));
	const backend = createDemoBackend();
	const folder = expectOk(
		await openFolder({ directory, tables: messagesTables }),
	);
	try {
		const draft = await seedDraft(folder, backend, 'demo-maya');
		expectOk(
			await folder.tables.drafts.set(draft.id, {
				body: 'Entered before close',
			}),
		);
		const sending = sendDraft(folder, draft.id, 'demo-maya', backend);
		const closing = folder.close();
		expectOk(await sending);
		await closing;
	} finally {
		await folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('a receipt does not erase a new composition accepted during the backend reply', async () => {
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
	const folder = expectOk(
		await openFolder({
			directory,
			tables: messagesTables,
			saveAfterMs: 60_000,
		}),
	);
	try {
		const draft = await seedDraft(folder, backend, 'demo-maya');
		const edit = folder.tables.drafts.edit(draft.id);
		expectOk(edit.change({ body: 'First reply' }));
		const sending = sendDraft(folder, draft.id, 'demo-maya', backend);
		await reached.promise;
		expectOk(
			edit.change({
				body: 'Next reply',
				fields: { state: 'draft', pendingId: '' },
			}),
		);
		release.resolve();
		expectOk(await sending);
		expect(edit.getSnapshot().content?.body).toBe('Next reply');
		expect(edit.getSnapshot().isDirty).toBe(true);
		expect(expectOk(await folder.tables.drafts.get(draft.id))?.body).toBe('');
		expect(await folder.settle()).toEqual([]);
		const row = expectOk(await folder.tables.drafts.get(draft.id));
		expect(row?.body).toBe('Next reply');
		expect(row?.fields?.state).toBe('draft');
	} finally {
		release.resolve();
		await folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test.each(['Same reply', 'Different next reply'])(
	'a stale composition cannot erase an uncertain attempt: %s',
	async (next) => {
		const directory = await mkdtemp(
			join(tmpdir(), 'epicenter-messages-attempt-'),
		);
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const demo = createDemoBackend();
		let sends = 0;
		const backend: Backend = {
			...demo,
			async request(request) {
				if (request.action === 'send') {
					sends++;
					reached.resolve();
					await release.promise;
					return { kind: 'error', message: 'Confirmation lost' };
				}
				return demo.request(request);
			},
		};
		const first = expectOk(
			await openFolder({
				directory,
				tables: messagesTables,
				saveAfterMs: 60_000,
			}),
		);
		const second = expectOk(
			await openFolder({
				directory,
				tables: messagesTables,
				saveAfterMs: 60_000,
			}),
		);
		try {
			const draft = await seedDraft(first, backend, 'demo-maya');
			expectOk(await first.tables.drafts.set(draft.id, { body: 'Same reply' }));
			expectOk(await second.tables.drafts.get(draft.id));
			const stale = second.tables.drafts.edit(draft.id);
			expectOk(stale.change({ body: next + '!' }));
			expectOk(stale.change({ body: next }));
			const sending = sendDraft(first, draft.id, 'demo-maya', backend);
			await reached.promise;
			expectOk(await stale.save());
			release.resolve();
			expectErr(await sending);
			expectErr(await sendDraft(second, draft.id, 'demo-maya', backend));
			expect(
				expectOk(await second.tables.attempts.get(draft.id))?.fields?.state,
			).toBe('sending');
			expect(sends).toBe(1);
			await second.close();
			const reopened = expectOk(
				await openFolder({ directory, tables: messagesTables }),
			);
			try {
				expectErr(await sendDraft(reopened, draft.id, 'demo-maya', backend));
				expect(sends).toBe(1);
			} finally {
				await reopened.close();
			}
		} finally {
			release.resolve();
			await first.close();
			await second.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test('a stale recovery clicked during a live send cannot restore an accepted message for another send', async () => {
	const directory = await mkdtemp(
		join(tmpdir(), 'epicenter-messages-recovery-'),
	);
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const demo = createDemoBackend();
	let sends = 0;
	const backend: Backend = {
		...demo,
		async request(request) {
			if (request.action === 'send') {
				sends++;
				reached.resolve();
				await release.promise;
			}
			return demo.request(request);
		},
	};
	const folder = expectOk(
		await openFolder({ directory, tables: messagesTables }),
	);
	try {
		const draft = await seedDraft(folder, backend, 'demo-maya');
		expectOk(await folder.tables.drafts.set(draft.id, { body: 'One reply' }));
		const sending = sendDraft(folder, draft.id, 'demo-maya', backend);
		await reached.promise;
		const recovering = recoverDraft(
			folder,
			draft.id,
			'demo-maya',
			backend,
			await checkedAttempt(folder, draft.id),
			true,
		);
		release.resolve();
		expectOk(await sending);
		expectOk(await recovering);
		expectErr(await sendDraft(folder, draft.id, 'demo-maya', backend));
		expect(sends).toBe(1);
	} finally {
		release.resolve();
		await folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('existing unresolved draft records require checked recovery before sending', async () => {
	const directory = await mkdtemp(
		join(tmpdir(), 'epicenter-messages-existing-'),
	);
	const backend = createDemoBackend();
	const folder = expectOk(
		await openFolder({ directory, tables: messagesTables }),
	);
	try {
		const draft = await seedDraft(folder, backend, 'demo-maya');
		expectOk(
			await folder.tables.drafts.set(draft.id, {
				fields: { state: 'sending' },
				body: 'Old uncertain reply',
			}),
		);
		expectErr(await sendDraft(folder, draft.id, 'demo-maya', backend));
		expectOk(
			await recoverDraft(
				folder,
				draft.id,
				'demo-maya',
				backend,
				await checkedAttempt(folder, draft.id),
				true,
			),
		);
		expect(
			expectOk(await folder.tables.attempts.get(draft.id))?.fields?.state,
		).toBe('acknowledged');
		expectOk(await sendDraft(folder, draft.id, 'demo-maya', backend));
	} finally {
		await folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('checked recovery for an older identical attempt cannot acknowledge a newer send', async () => {
	const directory = await mkdtemp(
		join(tmpdir(), 'epicenter-messages-stale-check-'),
	);
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const demo = createDemoBackend();
	let sends = 0;
	const backend: Backend = {
		...demo,
		async request(request) {
			if (request.action !== 'send') return demo.request(request);
			sends++;
			if (sends === 2) {
				reached.resolve();
				await release.promise;
			}
			return { kind: 'error', message: 'Confirmation lost' };
		},
	};
	const first = expectOk(
		await openFolder({ directory, tables: messagesTables }),
	);
	const second = expectOk(
		await openFolder({ directory, tables: messagesTables }),
	);
	try {
		const draft = await seedDraft(first, backend, 'demo-maya');
		expectOk(await first.tables.drafts.set(draft.id, { body: 'Same reply' }));
		expectOk(await first.tables.drafts.get(draft.id));
		expectErr(await sendDraft(first, draft.id, 'demo-maya', backend));
		const oldCheck = await checkedAttempt(first, draft.id);
		expectOk(
			await recoverDraft(
				second,
				draft.id,
				'demo-maya',
				backend,
				oldCheck,
				true,
			),
		);
		expectOk(await second.tables.drafts.get(draft.id));
		const sending = sendDraft(second, draft.id, 'demo-maya', backend);
		await reached.promise;
		expectErr(
			await recoverDraft(
				first,
				draft.id,
				'demo-maya',
				backend,
				oldCheck,
				false,
			),
		);
		release.resolve();
		expectErr(await sending);
		expectErr(await sendDraft(first, draft.id, 'demo-maya', backend));
		expect(sends).toBe(2);
	} finally {
		release.resolve();
		await first.close();
		await second.close();
		await rm(directory, { recursive: true, force: true });
	}
});
