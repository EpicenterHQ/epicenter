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
		expectOk(
			await folder.tables.drafts.document(draft.id).save({ body: text }),
		);
		backend.failNext();
		expectErr(await sendDraft(folder, draft.id, 'demo-maya', backend));
		expect(expectOk(await folder.tables.attempts.get(draft.id))?.body).toBe(
			text,
		);
		expect(expectOk(await folder.tables.drafts.get(draft.id))?.body).toBe('');
		folder.close();
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
		await folder.tables.attempts.document(draft.id).refresh();
		expectOk(await sendDraft(folder, draft.id, 'demo-maya', backend));
		expect(
			expectOk(await folder.tables.attempts.get(draft.id))?.fields?.state,
		).toBe('accepted');
		expect(expectOk(await folder.tables.drafts.get(draft.id))?.body).toBe('');
		expectErr(await sendDraft(folder, draft.id, 'demo-maya', backend));
	} finally {
		folder.close();
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
		const edit = folder.tables.drafts.document(draft.id);
		expectOk(edit.patch({ body: 'Accepted input not saved yet' }));
		await folder.tables.attempts.document(draft.id).refresh();
		expectOk(await sendDraft(folder, draft.id, 'demo-maya', backend));
		const answer = await backend.request({
			action: 'messages',
			chatId: 'demo-maya',
		});
		if (answer.kind !== 'messages')
			throw new Error('Could not read demo messages');
		expect(answer.page.items.at(-1)?.text).toBe('Accepted input not saved yet');
	} finally {
		folder.close();
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
			await folder.tables.drafts.document(draft.id).save({
				body: 'Must not send',
			}),
		);
		refuseWrites = true;
		expectErr(await sendDraft(folder, draft.id, 'demo-maya', backend));
		expect(sends).toBe(0);
	} finally {
		folder.close();
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
			await folder.tables.drafts.document(draft.id).save({
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
		folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('closing during a send keeps its durable uncertain attempt for recovery', async () => {
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
			await folder.tables.drafts.document(draft.id).save({
				body: 'Sent during close',
			}),
		);
		const sending = sendDraft(folder, draft.id, 'demo-maya', backend);
		await reached.promise;
		folder.close();
		expect(folder.getStatus().closing).toBe(true);
		expectErr(await sendDraft(folder, 'closed', 'demo-noah', backend));
		release.resolve();
		expect(expectErr(await sending).message).toContain('Check Beeper');
		const reopened = expectOk(
			await openFolder({ directory, tables: messagesTables }),
		);
		try {
			const receipt = expectOk(await reopened.tables.attempts.get(draft.id));
			expect(receipt?.fields?.state).toBe('sending');
			expect(receipt?.fields?.pendingId).toBe('');
			expect(receipt?.body).toBe('Sent during close');
		} finally {
			reopened.close();
		}
	} finally {
		release.resolve();
		folder.close();
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
			await folder.tables.drafts.document(draft.id).save({
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
		folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('a closed folder refuses a send before reading its draft', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-messages-test-'));
	const backend = createDemoBackend();
	const folder = expectOk(
		await openFolder({ directory, tables: messagesTables }),
	);
	try {
		const draft = await seedDraft(folder, backend, 'demo-maya');
		expectOk(
			await folder.tables.drafts.document(draft.id).save({
				body: 'Entered before close',
			}),
		);
		folder.close();
		expect(
			expectErr(await sendDraft(folder, draft.id, 'demo-maya', backend)).name,
		).toBe('Closing');
	} finally {
		folder.close();
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
		const edit = folder.tables.drafts.document(draft.id);
		expectOk(edit.patch({ body: 'First reply' }));
		const sending = sendDraft(folder, draft.id, 'demo-maya', backend);
		await reached.promise;
		expectOk(
			edit.patch({
				body: 'Next reply',
				fields: { state: 'draft', pendingId: '' },
			}),
		);
		release.resolve();
		expectOk(await sending);
		expect(edit.getSnapshot().content?.body).toBe('Next reply');
		expect(edit.getSnapshot().isDirty).toBe(true);
		expect(expectOk(await folder.tables.drafts.get(draft.id))?.body).toBe('');
		expectOk(await edit.save());
		const row = expectOk(await folder.tables.drafts.get(draft.id));
		expect(row?.body).toBe('Next reply');
		expect(row?.fields?.state).toBe('draft');
	} finally {
		release.resolve();
		folder.close();
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
			expectOk(
				await first.tables.drafts
					.document(draft.id)
					.save({ body: 'Same reply' }),
			);
			expectOk(await second.tables.drafts.document(draft.id).refresh());
			const stale = second.tables.drafts.document(draft.id);
			expectOk(stale.patch({ body: next + '!' }));
			expectOk(stale.patch({ body: next }));
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
			second.close();
			const reopened = expectOk(
				await openFolder({ directory, tables: messagesTables }),
			);
			try {
				expectErr(await sendDraft(reopened, draft.id, 'demo-maya', backend));
				expect(sends).toBe(1);
			} finally {
				reopened.close();
			}
		} finally {
			release.resolve();
			first.close();
			second.close();
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
		expectOk(
			await folder.tables.drafts.document(draft.id).save({ body: 'One reply' }),
		);
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
		folder.close();
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
			await folder.tables.drafts.document(draft.id).save({
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
		await folder.tables.attempts.document(draft.id).refresh();
		expectOk(await sendDraft(folder, draft.id, 'demo-maya', backend));
	} finally {
		folder.close();
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
		expectOk(
			await first.tables.drafts.document(draft.id).save({ body: 'Same reply' }),
		);
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
		expectOk(await second.tables.drafts.document(draft.id).refresh());
		await second.tables.attempts.document(draft.id).refresh();
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
		first.close();
		second.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('typing away from and back to the offered reply during attempt publication keeps the composer', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'messages-retyped-reply-'));
	const folder = expectOk(
		await openFolder({
			directory,
			tables: messagesTables,
			saveAfterMs: 60_000,
		}),
	);
	const demo = createDemoBackend();
	const sent: string[] = [];
	const backend: Backend = {
		...demo,
		request(request) {
			if (request.action === 'send') sent.push(request.text);
			return demo.request(request);
		},
	};
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	try {
		const draft = await seedDraft(folder, backend, 'demo-maya');
		const document = folder.tables.drafts.document(draft.id);
		expectOk(await document.save({ body: 'Prepared message' }));
		const write = folder.files.write;
		folder.files.write = async (path, content) => {
			const result = await write(path, content);
			if (path === `attempts/${draft.id}.md`) {
				entered.resolve();
				await release.promise;
			}
			return result;
		};

		const sending = sendDraft(folder, draft.id, 'demo-maya', backend);
		await entered.promise;
		expectOk(document.patch({ body: 'Next message' }));
		expectOk(document.patch({ body: 'Prepared message' }));
		release.resolve();
		expectOk(await sending);

		expect(sent).toEqual(['Prepared message']);
		expect(document.getSnapshot().content?.body).toBe('Prepared message');
		expectOk(await document.save());
		expect(expectOk(await folder.tables.drafts.get(draft.id))?.body).toBe(
			'Prepared message',
		);
	} finally {
		release.resolve();
		folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('close while sends wait for an attempt read and queue admission refuses both before sending', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'messages-close-queue-'));
	const folder = expectOk(
		await openFolder({ directory, tables: messagesTables }),
	);
	const demo = createDemoBackend();
	let sends = 0;
	const backend: Backend = {
		...demo,
		request(request) {
			if (request.action === 'send') sends++;
			return demo.request(request);
		},
	};
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	try {
		const draft = await seedDraft(folder, backend, 'demo-maya');
		expectOk(
			await folder.tables.drafts
				.document(draft.id)
				.save({ body: 'Do not send' }),
		);
		const get = folder.tables.attempts.get;
		folder.tables.attempts.get = async (id) => {
			const result = await get(id);
			entered.resolve();
			await release.promise;
			return result;
		};
		const first = sendDraft(folder, draft.id, 'demo-maya', backend);
		await entered.promise;
		const queued = sendDraft(folder, draft.id, 'demo-maya', backend);
		folder.close();
		release.resolve();
		expect(expectErr(await first).name).toBe('Closing');
		expect(expectErr(await queued).name).toBe('Closing');
		expect(sends).toBe(0);
		expect(
			await Bun.file(join(directory, `attempts/${draft.id}.md`)).exists(),
		).toBe(false);
	} finally {
		release.resolve();
		folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test.each(['attempt', 'changed', 'clear'] as const)(
	'close during send preparation at %s keeps the durable attempt and sends nothing',
	async (stage) => {
		const directory = await mkdtemp(
			join(tmpdir(), 'messages-close-preparation-'),
		);
		const folder = expectOk(
			await openFolder({
				directory,
				tables: messagesTables,
				saveAfterMs: 60_000,
			}),
		);
		const demo = createDemoBackend();
		let sends = 0;
		const backend: Backend = {
			...demo,
			request(request) {
				if (request.action === 'send') sends++;
				return demo.request(request);
			},
		};
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		try {
			const draft = await seedDraft(folder, backend, 'demo-maya');
			expectOk(
				await folder.tables.drafts
					.document(draft.id)
					.save({ body: 'Prepared message' }),
			);
			if (stage === 'clear') {
				const acquire = folder.tables.drafts.document;
				folder.tables.drafts.document = (id) => {
					const document = acquire(id);
					return {
						...document,
						async save(change) {
							const result = await document.save(change);
							entered.resolve();
							await release.promise;
							return result;
						},
					};
				};
			} else {
				const write = folder.files.write;
				folder.files.write = async (...args) => {
					const result = await write(...args);
					entered.resolve();
					await release.promise;
					return result;
				};
			}
			const sending = sendDraft(folder, draft.id, 'demo-maya', backend);
			await entered.promise;
			if (stage === 'changed')
				expectOk(
					folder.tables.drafts
						.document(draft.id)
						.patch({ body: 'Next message' }),
				);
			folder.close();
			release.resolve();
			const refused = expectErr(await sending);
			expect(refused.name).toBe('Refused');
			expect(refused.message).toContain('Nothing was sent');
			expect(sends).toBe(0);
			const attempt = await Bun.file(
				join(directory, `attempts/${draft.id}.md`),
			).text();
			expect(attempt).toContain('state: sending');
			expect(attempt).toContain('Prepared message');
		} finally {
			release.resolve();
			folder.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test.each(['read', 'write'] as const)(
	'close during recovery after %s reports whether the check was saved',
	async (stage) => {
		const directory = await mkdtemp(join(tmpdir(), 'messages-close-recovery-'));
		const folder = expectOk(
			await openFolder({ directory, tables: messagesTables }),
		);
		const backend = createDemoBackend();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		try {
			const draft = await seedDraft(folder, backend, 'demo-maya');
			expectOk(
				await folder.tables.attempts.write(draft.id, {
					fields: {
						chatId: 'demo-maya',
						profile: backend.profile,
						mode: backend.mode,
						state: 'sending',
						attemptId: 'checked',
						pendingId: '',
					},
					body: 'Uncertain message',
				}),
			);
			if (stage === 'read') {
				const get = folder.tables.drafts.get;
				folder.tables.drafts.get = async (id) => {
					const result = await get(id);
					entered.resolve();
					await release.promise;
					return result;
				};
			} else {
				const write = folder.files.write;
				folder.files.write = async (...args) => {
					const result = await write(...args);
					entered.resolve();
					await release.promise;
					return result;
				};
			}
			const recovering = recoverDraft(
				folder,
				draft.id,
				'demo-maya',
				backend,
				{ attemptId: 'checked' },
				true,
			);
			await entered.promise;
			folder.close();
			release.resolve();
			const error = expectErr(await recovering);
			expect(error.name).toBe(stage === 'read' ? 'Closing' : 'Refused');
			if (stage === 'write') {
				expect(error.message).toContain('The check was saved');
				expect(error.message).toContain('The attempt file keeps the text');
			}
			const attempt = await Bun.file(
				join(directory, `attempts/${draft.id}.md`),
			).text();
			expect(attempt).toContain(
				stage === 'read' ? 'state: sending' : 'state: acknowledged',
			);
		} finally {
			release.resolve();
			folder.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test('a failed composer clear retains accepted empty input and preserves the durable submitted body', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'messages-clear-failure-'));
	const storage = nativeStorage(directory);
	let refuseDrafts = false;
	let sends = 0;
	const demo = createDemoBackend();
	const backend: Backend = {
		...demo,
		request: async (request) => {
			if (request.action === 'send') sends++;
			return demo.request(request);
		},
	};
	const folder = createNativeFolder({
		directory: `bun:${directory}`,
		tables: messagesTables,
		storage: {
			...storage,
			put: (path, bytes, ifMatch) =>
				refuseDrafts && path.startsWith('drafts/')
					? Promise.resolve(
							FileError.Io({
								path,
								operation: 'write',
								cause: new Error('Draft storage refused'),
							}),
						)
					: storage.put(path, bytes, ifMatch),
		},
	});
	try {
		const draft = await seedDraft(folder, backend, 'demo-maya');
		expectOk(
			await folder.tables.drafts
				.document(draft.id)
				.save({ body: 'Prepared reply' }),
		);
		refuseDrafts = true;
		expectErr(await sendDraft(folder, draft.id, 'demo-maya', backend));
		const snapshot = folder.tables.drafts.document(draft.id).getSnapshot();
		expect(snapshot.content?.body).toBe('');
		expect(snapshot.isDirty).toBe(true);
		expect(snapshot.saveError?.name).toBe('StorageFailed');
		expect(expectOk(await folder.tables.attempts.get(draft.id))?.body).toBe(
			'Prepared reply',
		);
		expect(expectOk(await folder.tables.drafts.get(draft.id))?.body).toBe(
			'Prepared reply',
		);
		expect(sends).toBe(0);
	} finally {
		folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('typing as the cleared draft starts saving builds on the clear, and the sent text never returns', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-messages-clear-'));
	const backend = createDemoBackend();
	const sent: string[] = [];
	const counting: Backend = {
		...backend,
		async request(request) {
			if (request.action === 'send') sent.push(request.text);
			return backend.request(request);
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
		const draft = await seedDraft(folder, counting, 'demo-maya');
		const edit = folder.tables.drafts.document(draft.id);
		expectOk(edit.patch({ body: 'First reply' }));
		expectOk(await edit.save());
		const path = `drafts/${draft.id}.md`;
		// The person types the moment the clear's publication is admitted.
		let typed = false;
		const stop = folder.onStatusChange(({ savingPaths }) => {
			if (typed || !savingPaths.includes(path)) return;
			typed = true;
			const body = edit.getSnapshot().content?.body ?? '';
			expectOk(edit.patch({ body: `${body}Next` }));
		});
		expectOk(await sendDraft(folder, draft.id, 'demo-maya', counting));
		stop();
		expect(typed).toBe(true);
		expect(sent).toEqual(['First reply']);
		// The typing composed over the cleared draft; nothing sent came back.
		expect(edit.getSnapshot()).toMatchObject({
			isDirty: true,
			content: { body: 'Next' },
		});
		expectOk(await edit.save());
		expect(expectOk(await folder.tables.drafts.get(draft.id))?.body).toBe(
			'Next',
		);
		expect(
			expectOk(await folder.tables.attempts.get(draft.id))?.fields?.state,
		).toBe('accepted');
	} finally {
		folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});
