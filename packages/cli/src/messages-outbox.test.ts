/**
 * Messages' send owner, over a real folder of reply notes and a real
 * SQLite journal, with a fake Beeper that records every send it is asked.
 *
 * Key behaviors:
 * - Saving a draft or a ready reply, listing, and checking never send
 * - A send is claimed, with its exact text, on disk before Beeper is asked
 * - A claim with no answer is never asked again: after a restart it waits
 *   for a person, holds back its chat, and other chats go on
 * - A reply changed since it was selected, not ready, or for other accounts
 *   is skipped and nothing is claimed
 * - Of two owners sending one reply at once, Beeper is asked once
 * - Beeper's confirmation removes the note only while it is the text sent
 * - A failed send, or one a person found was not sent, stays reviewable
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDevice } from '@epicenter/folder/node';
import { unwrap } from 'wellcrafted/result';
import { messagesContract } from './messages-contract.js';
import { openSendJournal } from './messages-journal.js';
import { type Beeper, createMessages } from './messages-outbox.js';
import type {
	MessagesAnswer,
	MessagesRequest,
	Reply,
	SendResult,
} from './messages-protocol.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

const PROFILE = 'fictional-profile';

/** A Beeper that answers `next` for each send and records every one it is asked. */
function fakeBeeper() {
	const asked: { chatId: string; text: string }[] = [];
	const statuses = new Map<string, string | null>();
	const fake = {
		asked,
		statuses,
		profile: PROFILE as string | null,
		next: async (chatId: string): ReturnType<Beeper['send']> => ({
			kind: 'accepted',
			pendingId: `pending-${asked.length}`,
			chatId,
		}),
		statusChecks: 0,
	};
	const beeper: Beeper = {
		request: async () => ({ kind: 'error', message: 'Not used here.' }),
		profile: async () =>
			fake.profile === null
				? { message: 'Beeper is not connected.' }
				: { profile: fake.profile },
		async send(chatId, text) {
			asked.push({ chatId, text });
			return fake.next(chatId);
		},
		async status(_chatId, pendingId) {
			fake.statusChecks++;
			return { kind: 'status', status: statuses.get(pendingId) ?? 'PENDING' };
		},
	};
	return { fake, beeper };
}

async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'messages-outbox-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const folder = join(root, 'Messages');
	const journalPath = join(root, 'data', 'messages', 'sends.sqlite');
	const device = unwrap(await openDevice(messagesContract, { path: folder }));
	const { fake, beeper } = fakeBeeper();
	/** One owner, as one process opens it: its own journal connection. */
	function owner(over: Beeper = beeper) {
		const journal = openSendJournal(journalPath);
		cleanup.push(() => journal.close());
		const messages = createMessages({
			replies: device.replies,
			journal,
			beeper: over,
		});
		return (request: MessagesRequest) => messages.answer(request);
	}
	return { folder, journalPath, device, fake, beeper, owner };
}

type Ask = (request: MessagesRequest) => Promise<MessagesAnswer>;

async function save(
	ask: Ask,
	id: string,
	{
		chatId = 'chat-ada',
		status = 'ready',
		body = 'See you at ten',
		over,
	}: {
		chatId?: string;
		status?: 'draft' | 'ready';
		body?: string;
		over?: string;
	} = {},
) {
	const answer = await ask({
		action: 'save',
		id,
		...(over === undefined ? {} : { over }),
		chatId,
		chatTitle: 'Ada Test',
		profile: PROFILE,
		status,
		body,
	});
	if (answer.kind !== 'saved') throw new Error(JSON.stringify(answer));
	return answer.reply;
}

async function listed(ask: Ask) {
	const answer = await ask({ action: 'replies' });
	if (answer.kind !== 'replies') throw new Error(JSON.stringify(answer));
	return answer;
}

async function send(ask: Ask, ...replies: Reply[]) {
	const answer = await ask({
		action: 'send',
		items: replies.map(({ id, version }) => ({ id, over: version })),
	});
	if (answer.kind !== 'sent') throw new Error(JSON.stringify(answer));
	return answer.results;
}

const outcomes = (results: SendResult[]) =>
	results.map((result) => [result.id, result.outcome]);

test('saving drafts and ready replies, listing, and editing never send', async () => {
	const { fake, owner, folder } = await setup();
	const ask = owner();
	const draft = await save(ask, 'r1', { status: 'draft', body: 'Maybe' });
	const ready = await save(ask, 'r1', {
		status: 'ready',
		body: 'Maybe ten?',
		over: draft.version,
	});
	expect(ready.status).toBe('ready');
	expect((await listed(ask)).replies.map((reply) => reply.id)).toEqual(['r1']);
	expect(await Bun.file(join(folder, 'replies/r1.md')).text()).toBe(
		'---\nchatId: chat-ada\nchatTitle: Ada Test\nprofile: fictional-profile\nstatus: ready\n---\nMaybe ten?',
	);
	expect(fake.asked).toEqual([]);
	expect(fake.statusChecks).toBe(0);
});

test('a send is claimed with its exact text on disk before Beeper is asked, and confirmation removes the note', async () => {
	const { fake, owner, journalPath, folder } = await setup();
	const ask = owner();
	const reply = await save(ask, 'r1');
	let seenAtSend: unknown;
	fake.next = async () => {
		// Another connection, as another process would see the file.
		const other = openSendJournal(journalPath);
		seenAtSend = other
			.unsettled()
			.map(({ state, text, replyVersion }) => ({ state, text, replyVersion }));
		other.close();
		return { kind: 'accepted', pendingId: 'pending-1', chatId: 'member' };
	};
	expect(outcomes(await send(ask, reply))).toEqual([['r1', 'accepted']]);
	expect(seenAtSend).toEqual([
		{ state: 'claimed', text: 'See you at ten', replyVersion: reply.version },
	]);
	expect(fake.asked).toEqual([{ chatId: 'chat-ada', text: 'See you at ten' }]);

	// Accepted is not yet confirmed: the note stays, and cannot be sent again.
	const pending = await listed(ask);
	expect(pending.replies[0]?.send?.state).toBe('accepted');
	expect(outcomes(await send(ask, reply))).toEqual([['r1', 'skipped']]);
	expect(fake.asked).toHaveLength(1);

	fake.statuses.set('pending-1', 'SUCCESS');
	expect(await ask({ action: 'check' })).toEqual({ kind: 'checked' });
	expect(await Bun.file(join(folder, 'replies/r1.md')).exists()).toBe(false);
	const journal = openSendJournal(journalPath);
	expect(journal.ofReplies(['r1']).map(({ state, text }) => ({ state, text })))
		.toEqual([{ state: 'sent', text: null }]);
	journal.close();
	// The id is spent: it is never made again.
	expect(
		(
			await ask({
				action: 'save',
				id: 'r1',
				chatId: 'chat-ada',
				profile: PROFILE,
				status: 'ready',
				body: 'See you at ten',
			})
		).kind,
	).toBe('error');
});

test('a claim with no answer is never asked again: after a restart it waits for a person and holds its chat back', async () => {
	const { fake, owner, beeper, journalPath } = await setup();
	const first = owner();
	const ada = await save(first, 'r1', { body: 'First' });
	const adaLater = await save(first, 'r2', { body: 'Second' });
	const bo = await save(first, 'r3', { chatId: 'chat-bo', body: 'Hi Bo' });
	// The process stops while Beeper is being asked: the send never answers.
	fake.next = () => new Promise(() => {});
	void send(first, ada);
	await Bun.sleep(20);
	expect(fake.asked).toHaveLength(1);

	// A new process over the same folder and journal.
	fake.next = async (chatId) => ({
		kind: 'accepted',
		pendingId: `pending-${fake.asked.length}`,
		chatId,
	});
	const restarted = owner(beeper);
	// The test's old owner still exists in this process. Give its claim the
	// dead PID a real process crash would leave behind.
	const crashed = openSendJournal(journalPath);
	const crashedAttempt = crashed.unsettled()[0];
	if (!crashedAttempt) throw new Error('No claimed attempt');
	crashed.update(crashedAttempt.attemptId, { activePid: 2147483647, updatedAt: new Date().toISOString() }, ['claimed']);
	crashed.close();
	const shown = await listed(restarted);
	expect(shown.replies.find((reply) => reply.id === 'r1')?.send).toMatchObject(
		{ state: 'claimed', sending: false, text: 'First' },
	);
	expect(outcomes(await send(restarted, ada, adaLater, bo))).toEqual([
		['r1', 'skipped'],
		['r2', 'skipped'],
		['r3', 'accepted'],
	]);
	expect(fake.asked.map((call) => call.text)).toEqual(['First', 'Hi Bo']);

	// The person checked Beeper: it was not sent. The note stays, and only a
	// new, explicit send asks again.
	const attemptId = shown.replies.find((reply) => reply.id === 'r1')?.send
		?.attemptId;
	if (attemptId === undefined) throw new Error('No attempt');
	expect(
		await restarted({ action: 'resolve', attemptId, outcome: 'not-sent' }),
	).toEqual({ kind: 'resolved' });
	expect(fake.asked).toHaveLength(2);
	expect(outcomes(await send(restarted, ada, adaLater))).toEqual([
		['r1', 'accepted'],
		['r2', 'accepted'],
	]);
	expect(fake.asked.map((call) => call.text)).toEqual([
		'First',
		'Hi Bo',
		'First',
		'Second',
	]);
});

test('another process cannot resolve a claim while its sender is still waiting for Beeper', async () => {
	const { fake, owner, journalPath } = await setup();
	const sender = owner();
	const reviewer = owner();
	const reply = await save(sender, 'r1');
	let entered!: () => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	let finish!: (answer: Awaited<ReturnType<Beeper['send']>>) => void;
	const pending = new Promise<Awaited<ReturnType<Beeper['send']>>>((resolve) => { finish = resolve; });
	fake.next = async () => { entered(); return pending; };
	const sending = send(sender, reply);
	await started;
	const journal = openSendJournal(journalPath);
	const attempt = journal.unsettled()[0];
	journal.close();
	if (!attempt) throw new Error('No claimed attempt');
	expect((await listed(reviewer)).replies[0]?.send?.sending).toBe(true);
	expect(await reviewer({ action: 'resolve', attemptId: attempt.attemptId, outcome: 'not-sent' })).toMatchObject({ kind: 'error' });
	finish({ kind: 'unknown', message: 'Beeper did not confirm the send.' });
	await sending;
	expect(await reviewer({ action: 'resolve', attemptId: attempt.attemptId, outcome: 'not-sent' })).toEqual({ kind: 'resolved' });
	expect(fake.asked).toHaveLength(1);
});

test('an unknown outcome holds back later replies to its chat in the same send; other chats go on', async () => {
	const { fake, owner } = await setup();
	const ask = owner();
	const one = await save(ask, 'r1', { body: 'One' });
	const two = await save(ask, 'r2', { body: 'Two' });
	const other = await save(ask, 'r3', { chatId: 'chat-bo', body: 'Hi' });
	fake.next = async (chatId) =>
		chatId === 'chat-ada'
			? { kind: 'unknown', message: 'Beeper did not confirm the send.' }
			: { kind: 'accepted', pendingId: 'p', chatId };
	const results = await send(ask, one, two, other);
	expect(outcomes(results)).toEqual([
		['r1', 'uncertain'],
		['r2', 'skipped'],
		['r3', 'accepted'],
	]);
	expect(fake.asked.map((call) => call.text)).toEqual(['One', 'Hi']);
	const shown = await listed(ask);
	expect(shown.replies.find((reply) => reply.id === 'r1')?.send?.state).toBe(
		'claimed',
	);
});

test('a reply changed since it was selected, not ready, or for other accounts is skipped and nothing is claimed', async () => {
	const { fake, owner, folder } = await setup();
	const ask = owner();
	const changed = await save(ask, 'r1');
	await writeFile(
		join(folder, 'replies/r1.md'),
		'---\nchatId: chat-ada\nprofile: fictional-profile\nstatus: ready\n---\nEdited by an agent',
	);
	const draft = await save(ask, 'r2', { status: 'draft' });
	const elsewhere = await save(ask, 'r3');
	fake.profile = 'another-profile';
	expect(outcomes(await send(ask, changed, draft, elsewhere))).toEqual([
		['r1', 'skipped'],
		['r2', 'skipped'],
		['r3', 'skipped'],
	]);
	fake.profile = null;
	expect(outcomes(await send(ask, elsewhere))).toEqual([['r3', 'skipped']]);
	expect(fake.asked).toEqual([]);
	expect(
		(await listed(ask)).replies.every((reply) => reply.send === undefined),
	).toBe(true);
});

test('of two owners sending one reply at once, Beeper is asked once', async () => {
	const { fake, owner } = await setup();
	const one = owner();
	const two = owner();
	const reply = await save(one, 'r1');
	const [a, b] = await Promise.all([send(one, reply), send(two, reply)]);
	expect([...outcomes(a), ...outcomes(b)].map(([, outcome]) => outcome).sort())
		.toEqual(['accepted', 'skipped']);
	expect(fake.asked).toHaveLength(1);
});

test('a note edited after its send is kept when Beeper confirms the send', async () => {
	const { fake, owner, folder } = await setup();
	const ask = owner();
	const reply = await save(ask, 'r1');
	await send(ask, reply);
	await save(ask, 'r1', { body: 'A follow-up', over: reply.version });
	fake.statuses.set('pending-1', 'SUCCESS');
	await ask({ action: 'check' });
	expect(await Bun.file(join(folder, 'replies/r1.md')).text()).toContain(
		'A follow-up',
	);
	const shown = await listed(ask);
	expect(shown.replies.map(({ id, body, send }) => [id, body, send?.state]))
		.toEqual([['r1', 'A follow-up', 'sent']]);
});

test('a failed send keeps its note, and a send found not sent comes back as a draft when its note is gone', async () => {
	const { fake, owner, folder, device } = await setup();
	const ask = owner();
	const failing = await save(ask, 'r1', { body: 'Undeliverable' });
	await send(ask, failing);
	fake.statuses.set('pending-1', 'FAIL_PERMANENT');
	await ask({ action: 'check' });
	const afterFailure = await listed(ask);
	expect(afterFailure.replies.map(({ id, send }) => [id, send?.state])).toEqual(
		[['r1', 'failed']],
	);
	expect(fake.asked).toHaveLength(1);
	// If the note vanished after the failed status was recorded, listing
	// restores the journal's unsent text as an ordinary draft.
	unwrap(await device.replies.delete({ id: 'r1' }, { over: afterFailure.replies[0]!.version }));
	const recovered = await listed(ask);
	expect(recovered.replies.find(({ id }) => id === 'r1')).toMatchObject({ body: 'Undeliverable', status: 'draft' });

	const lost = await save(ask, 'r2', { chatId: 'chat-bo', body: 'Lost' });
	fake.next = async () => ({ kind: 'unknown', message: 'No answer.' });
	await send(ask, lost);
	unwrap(await device.replies.delete({ id: 'r2' }, { over: lost.version }));
	const orphan = (await listed(ask)).unfiled;
	expect(orphan.map(({ replyId, text }) => [replyId, text])).toEqual([
		['r2', 'Lost'],
	]);
	const attemptId = orphan[0]?.attemptId;
	if (attemptId === undefined) throw new Error('No attempt');
	await ask({ action: 'resolve', attemptId, outcome: 'not-sent' });
	expect(await Bun.file(join(folder, 'replies/r2.md')).text()).toBe(
		'---\nchatId: chat-bo\nchatTitle: Ada Test\nprofile: fictional-profile\nstatus: draft\n---\nLost',
	);
	expect((await listed(ask)).unfiled).toEqual([]);
});
