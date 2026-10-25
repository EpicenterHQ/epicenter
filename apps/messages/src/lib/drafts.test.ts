/**
 * Messages draft workflow tests.
 *
 * The attempt must land before a backend send, uncertain sends require an
 * explicit check, and composer changes after Send remain available.
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import {
	createFolder,
	memoryHost,
	ReadError,
	SaveError,
	tick,
} from '@epicenter/folder/next/testing';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type Backend, createDemoBackend } from './backend.js';
import { messagesTables } from './definition.js';
import { saveDraft, seedDraft } from './drafts.test-support.js';

const { svelteFolder } = await import('@epicenter/svelte/folder-next');
const { draftId, recoverDraft, sendDraft } = await import('./drafts.js');

async function setup() {
	const host = memoryHost();
	const opened = expectOk(
		await createFolder(host.storage, { tables: messagesTables, throttleMs: 0 }),
	);
	const folder = svelteFolder(opened);
	const backend = createDemoBackend();
	const { id } = await seedDraft(folder, backend, 'demo-maya');
	return { host, opened, folder, backend, id };
}

function attemptId(
	folder: Awaited<ReturnType<typeof setup>>['folder'],
	id: string,
) {
	const row = folder.tables.attempts.row(id);
	return row?.issues === null ? row.fields.attemptId : undefined;
}

function send(
	folder: Awaited<ReturnType<typeof setup>>['folder'],
	id: string,
	backend: Backend,
	text: string,
	previousAttemptId = attemptId(folder, id),
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
	folder: Awaited<ReturnType<typeof setup>>['folder'],
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

test('an uncertain attempt holds its text and blocks resending until checked', async () => {
	const { folder, opened, backend, id } = await setup();
	try {
		const text = 'A draft with Markdown and "quotes".';
		expectOk(await saveDraft(folder, id, { body: text }));
		backend.failNext();
		expectErr(await send(folder, id, backend, text));
		const attempt = folder.tables.attempts.row(id);
		expect(attempt?.issues).toBeNull();
		expect(attempt?.body).toBe(text);
		expect(attempt?.fields?.state).toBe('sending');
		expect(folder.tables.drafts.row(id)?.body).toBe('');
		expectErr(await send(folder, id, backend, text, attemptId(folder, id)));
		expectOk(await check(folder, id, backend, attemptId(folder, id) ?? ''));
		expect(folder.tables.drafts.row(id)?.body).toBe(text);
		expect(folder.tables.attempts.row(id)?.fields?.state).toBe('acknowledged');
		expectOk(await send(folder, id, backend, text));
		expect(folder.tables.attempts.row(id)?.fields?.state).toBe('accepted');
	} finally {
		await opened.close();
	}
});

test('demo and live drafts use different IDs', async () => {
	const demo = createDemoBackend();
	expect(await draftId(demo, 'same')).not.toBe(
		await draftId({ mode: 'live', profile: demo.profile }, 'same'),
	);
});

test('a failed attempt write never contacts Beeper', async () => {
	const { host, folder, opened, backend, id } = await setup();
	let sends = 0;
	const counting: Backend = {
		...backend,
		request(request) {
			if (request.action === 'send') sends++;
			return backend.request(request);
		},
	};
	try {
		expectOk(await saveDraft(folder, id, { body: 'Must not send' }));
		host.control.failPut.set(
			`attempts/${id}.md`,
			expectErr(SaveError.StorageFailed({ cause: 'no disk' })),
		);
		expect(
			expectErr(await send(folder, id, counting, 'Must not send')).message,
		).toBe('Nothing was sent: the attempt could not be saved.');
		expect(sends).toBe(0);
	} finally {
		await opened.close();
	}
});

test('two concurrent sends reach Beeper once', async () => {
	const { folder, opened, backend, id } = await setup();
	let sends = 0;
	const counting: Backend = {
		...backend,
		request(request) {
			if (request.action === 'send') sends++;
			return backend.request(request);
		},
	};
	try {
		expectOk(await saveDraft(folder, id, { body: 'Only once' }));
		const [first, second] = await Promise.all([
			send(folder, id, counting, 'Only once'),
			send(folder, id, counting, 'Only once'),
		]);
		expectOk(first);
		expectErr(second);
		expect(sends).toBe(1);
	} finally {
		await opened.close();
	}
});

test('typing after Send survives the receipt', async () => {
	const { folder, opened, backend, id } = await setup();
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
	try {
		expectOk(await saveDraft(folder, id, { body: 'First reply' }));
		const sending = send(folder, id, gated, 'First reply');
		await reached.promise;
		expectOk(await saveDraft(folder, id, { body: 'Next reply' }));
		release.resolve();
		expectOk(await sending);
		expect(folder.tables.drafts.row(id)?.body).toBe('Next reply');
		expect(folder.tables.attempts.row(id)?.fields?.state).toBe('accepted');
	} finally {
		release.resolve();
		await opened.close();
	}
});

test('typing after Send is not cleared before Beeper is contacted', async () => {
	const { folder, opened, backend, id } = await setup();
	let sends = 0;
	const counting: Backend = {
		...backend,
		request(request) {
			if (request.action === 'send') sends++;
			return backend.request(request);
		},
	};
	try {
		expectOk(await saveDraft(folder, id, { body: 'Next reply' }));
		expectOk(
			await send(folder, id, counting, 'First reply', undefined, () => false),
		);
		expect(folder.tables.drafts.row(id)?.body).toBe('Next reply');
		expect(folder.tables.attempts.row(id)?.fields?.state).toBe('accepted');
		expect(sends).toBe(1);
	} finally {
		await opened.close();
	}
});

test('a stale recovery cannot restore an accepted send', async () => {
	const { folder, opened, backend, id } = await setup();
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
	try {
		expectOk(await saveDraft(folder, id, { body: 'One reply' }));
		const sending = send(folder, id, gated, 'One reply');
		await reached.promise;
		const checkedId = attemptId(folder, id) ?? '';
		const recovering = check(folder, id, gated, checkedId);
		release.resolve();
		expectOk(await sending);
		expectOk(await recovering);
		expect(folder.tables.drafts.row(id)?.body).toBe('');
		expect(folder.tables.attempts.row(id)?.fields?.state).toBe('accepted');
		expect(sends).toBe(1);
	} finally {
		release.resolve();
		await opened.close();
	}
});

test('checking an older identical attempt cannot acknowledge a newer one', async () => {
	const { folder, opened, backend, id } = await setup();
	try {
		expectOk(await saveDraft(folder, id, { body: 'Same reply' }));
		backend.failNext();
		expectErr(await send(folder, id, backend, 'Same reply'));
		const oldId = attemptId(folder, id) ?? '';
		expectOk(await check(folder, id, backend, oldId));
		backend.failNext();
		expectErr(await send(folder, id, backend, 'Same reply'));
		const newId = attemptId(folder, id);
		expect(newId).not.toBe(oldId);
		expectErr(await check(folder, id, backend, oldId));
		expect(folder.tables.attempts.row(id)?.fields?.state).toBe('sending');
	} finally {
		await opened.close();
	}
});

test('a failed clear sends nothing and acknowledges the attempt', async () => {
	const { host, folder, opened, backend, id } = await setup();
	let sends = 0;
	const counting: Backend = {
		...backend,
		request(request) {
			if (request.action === 'send') sends++;
			return backend.request(request);
		},
	};
	try {
		expectOk(await saveDraft(folder, id, { body: 'Prepared reply' }));
		host.control.failPut.set(
			`drafts/${id}.md`,
			expectErr(SaveError.StorageFailed({ cause: 'no disk' })),
		);
		expect(
			expectErr(await send(folder, id, counting, 'Prepared reply')).message,
		).toContain('Nothing was sent');
		expect(sends).toBe(0);
		expect(folder.tables.drafts.row(id)?.body).toBe('Prepared reply');
		expect(folder.tables.attempts.row(id)?.fields?.state).toBe('acknowledged');
	} finally {
		await opened.close();
	}
});

test('broken draft frontmatter refuses a send', async () => {
	const { host, folder, opened, backend, id } = await setup();
	let sends = 0;
	const counting: Backend = {
		...backend,
		request(request) {
			if (request.action === 'send') sends++;
			return backend.request(request);
		},
	};
	try {
		host.outside(`drafts/${id}.md`, '---\nchatId: [\n---\nOriginal');
		folder.checkpoint();
		await tick();
		expect(folder.tables.drafts.row(id)?.issues).not.toBeNull();
		expectErr(await send(folder, id, counting, 'Edited'));
		expect(sends).toBe(0);
	} finally {
		await opened.close();
	}
});

test('an attempt on storage that the mirror has not seen refuses a send', async () => {
	const { host, folder, opened, backend, id } = await setup();
	try {
		host.outside(
			`attempts/${id}.md`,
			'---\nstate: sending\n---\nAnother send',
			{ hint: false },
		);
		expect(
			expectErr(await send(folder, id, backend, 'Must not send')).message,
		).toContain('Another send');
	} finally {
		await opened.close();
	}
});

test('a BOM in a mirrored attempt does not block the next send', async () => {
	const { host, folder, opened, backend, id } = await setup();
	try {
		expectOk(await saveDraft(folder, id, { body: 'First reply' }));
		expectOk(await send(folder, id, backend, 'First reply'));
		const path = `attempts/${id}.md`;
		host.outside(path, `\uFEFF${host.text(path) ?? ''}`);
		folder.checkpoint();
		await tick();
		expect(folder.tables.attempts.row(id)?.issues).toBeNull();
		expectOk(await saveDraft(folder, id, { body: 'Second reply' }));
		expectOk(await send(folder, id, backend, 'Second reply'));
	} finally {
		await opened.close();
	}
});

test('a failed storage read asks to try again', async () => {
	const { host, folder, opened, backend, id } = await setup();
	const read = host.storage.read;
	host.storage.read = async (paths) =>
		new Map(
			paths.map(
				(path) =>
					[path, ReadError.StorageFailed({ cause: 'read failed' })] as const,
			),
		);
	try {
		expect(
			expectErr(await send(folder, id, backend, 'Must not send')).message,
		).toBe('Could not check storage; try again.');
	} finally {
		host.storage.read = read;
		await opened.close();
	}
});

test('a changed draft chatId cannot redirect a send', async () => {
	const { folder, opened, backend, id } = await setup();
	let sends = 0;
	const counting: Backend = {
		...backend,
		request(request) {
			if (request.action === 'send') sends++;
			return backend.request(request);
		},
	};
	try {
		expectOk(
			await saveDraft(folder, id, {
				fields: { chatId: 'demo-noah' },
				body: 'Private reply',
			}),
		);
		expectErr(await send(folder, id, counting, 'Private reply'));
		expect(sends).toBe(0);
	} finally {
		await opened.close();
	}
});

test('a write after close returns Closed and sends nothing', async () => {
	const { folder, opened, backend, id } = await setup();
	let sends = 0;
	const counting: Backend = {
		...backend,
		request(request) {
			if (request.action === 'send') sends++;
			return backend.request(request);
		},
	};
	expectOk(await saveDraft(folder, id, { body: 'Not sent' }));
	await opened.close();
	expect(expectErr(await send(folder, id, counting, 'Not sent')).message).toBe(
		'Nothing was sent: the attempt could not be saved.',
	);
	expect(sends).toBe(0);
});
