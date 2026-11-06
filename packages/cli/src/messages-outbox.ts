/**
 * Messages' one send owner: every reply that reaches Beeper goes through
 * `createMessages`, whether the page asked (through the local program),
 * `epicenter messages --json` asked, or the in-browser demo did, so the
 * rules below hold for all of them.
 *
 * A reply is a note in the folder (`messages-contract.ts`); saving it as a
 * draft or ready sends nothing. `send` takes ready replies, each named with
 * the version that was reviewed, and for each, in order:
 *
 * 1. reads the note and skips it unless it is still that version, ready,
 *    written for the connected Beeper accounts, and fits one message;
 * 2. claims it in the journal: one durable, atomic record of the attempt
 *    and its exact text, refused while the reply has an unsettled send,
 *    while its chat has a send nobody knows the outcome of, or when this
 *    exact version was already sent;
 * 3. asks Beeper once, and records what Beeper said.
 *
 * Nothing is ever asked twice on its own. A claim with no answer (Beeper
 * did not respond, or the process stopped) stays `claimed` until a person
 * checks Beeper and says what happened (`resolve`), and holds back later
 * replies to that chat; other chats go on. An accepted send carries
 * Beeper's pending id, which `check` follows to the delivery Beeper
 * reports. Once Beeper confirms the exact text was sent, its note is
 * removed (only if nobody edited it since) and the journal forgets the
 * text. A failed send, or one a person found was not sent, keeps its note,
 * and has it written back as a draft if the note is gone.
 *
 * This module has no file system, network or SQLite of its own: the
 * journal, the replies, and Beeper are handed in, so the local program and
 * the demo share it.
 */
import type {
	ClientError,
	NoteClient,
	NoteOf,
} from '@epicenter/definition/contract';
import type { MessagesContract } from './messages-contract.js';
import {
	type BeeperRead,
	MAX_TEXT,
	type MessagesAnswer,
	type MessagesRequest,
	type Reply,
	type Send,
	type SendResult,
	type SendState,
} from './messages-protocol.js';

type ReplyCollection = MessagesContract['collections']['replies'];
export type Replies = Pick<
	NoteClient<ReplyCollection>,
	'list' | 'get' | 'create' | 'update' | 'replace' | 'delete'
>;
type ReplyNote = NoteOf<ReplyCollection>;

/** One send attempt as the journal keeps it. */
export type Attempt = {
	attemptId: string;
	replyId: string;
	/** The version of the reply note whose text was claimed. */
	replyVersion: string;
	chatId: string;
	chatTitle: string | null;
	profile: string;
	text: string | null;
	state: SendState;
	/** Process still waiting for Beeper's answer; null once that wait ends. */
	activePid: number | null;
	pendingId: string | null;
	/** The chat Beeper routed the send to (a merged chat's member). */
	routedChatId: string | null;
	delivery: string | null;
	note: string | null;
	claimedAt: string;
	updatedAt: string;
};
export type AttemptPatch = Partial<
	Pick<
		Attempt,
		'state' | 'text' | 'activePid' | 'pendingId' | 'routedChatId' | 'delivery' | 'note'
	>
>;

/** States a send has not settled from. */
export const UNSETTLED: readonly SendState[] = ['claimed', 'accepted'];

/** A live sender may still reach Beeper; a second process must not settle its claim. */
function processIsAlive(pid: number) {
	if (typeof process === 'undefined') return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string }).code !== 'ESRCH';
	}
}

/**
 * Where send attempts are recorded, durably, before Beeper is asked.
 * `messages-journal.ts` keeps them in SQLite; `createMemoryJournal` in
 * memory, for the demo.
 */
export type Journal = {
	/**
	 * Record `attempt` unless something blocks it, atomically with the check:
	 * an unsettled attempt of the same reply, a `claimed` attempt to the same
	 * chat, or a `sent` attempt of the same reply version. Answers the
	 * blocking attempt, or null once `attempt` is recorded and durable.
	 */
	claim(attempt: Attempt): Attempt | null;
	/** Change the attempt if it is in one of `from`; answers it as changed, or undefined. */
	update(
		attemptId: string,
		patch: AttemptPatch & { updatedAt: string },
		from: readonly SendState[],
	): Attempt | undefined;
	get(attemptId: string): Attempt | undefined;
	/** Every unsettled attempt, oldest first. */
	unsettled(): Attempt[];
	/** Latest attempt for each reply, when it still holds unsent text. */
	latestWithText(): Attempt[];
	/** Every attempt of these replies, oldest first. */
	ofReplies(replyIds: readonly string[]): Attempt[];
};

/** Beeper, as the owner uses it. */
export type Beeper = {
	/** Read operations, answered as they are. */
	request(request: BeeperRead): Promise<MessagesAnswer>;
	/** The connected accounts' profile, or why there is none. Never sends. */
	profile(): Promise<{ profile: string } | { message: string }>;
	/**
	 * Ask Beeper once to send `text`. `refused`: Beeper answered that it did
	 * not take it. `unknown`: no answer says either way.
	 */
	send(
		chatId: string,
		text: string,
	): Promise<
		| { kind: 'accepted'; pendingId: string; chatId: string }
		| { kind: 'refused' | 'unknown'; message: string }
	>;
	/** The delivery status Beeper reports for a pending id, null when it reports none. */
	status(
		chatId: string,
		pendingId: string,
	): Promise<
		{ kind: 'status'; status: string | null } | { kind: 'error'; message: string }
	>;
};

const failed = (message: string): MessagesAnswer => ({
	kind: 'error',
	message,
});

function describe(error: ClientError) {
	switch (error.name) {
		case 'Conflict':
			return 'This reply changed in the Messages folder since it was opened. Reload it, then save again.';
		case 'NotFound':
			return 'This reply is no longer in the Messages folder.';
		case 'Occupied':
			return 'A reply with this id is already in the Messages folder.';
		case 'Invalid':
			return error.message;
		case 'Unavailable':
			return 'The Messages folder could not be read or written.';
	}
}

const tooLong = `A message can be at most ${MAX_TEXT.toLocaleString('en-US')} characters.`;

export function createMessages({
	replies,
	journal,
	beeper,
	now = () => new Date().toISOString(),
}: {
	replies: Replies;
	journal: Journal;
	beeper: Beeper;
	now?: () => string;
}) {
	/** Claims this owner is asking Beeper about right now. */
	const sending = new Set<string>();

	const view = (attempt: Attempt): Send => ({
		attemptId: attempt.attemptId,
		replyId: attempt.replyId,
		chatId: attempt.chatId,
		chatTitle: attempt.chatTitle,
		profile: attempt.profile,
		state: attempt.state,
		text: attempt.text,
		delivery: attempt.delivery,
		note: attempt.note,
		claimedAt: attempt.claimedAt,
		sending:
			sending.has(attempt.attemptId) ||
			(attempt.activePid !== null && processIsAlive(attempt.activePid)),
	});

	const reply = (note: ReplyNote, attempt?: Attempt): Reply => ({
		id: note.id,
		version: note.version,
		chatId: note.chatId,
		...(note.chatTitle === undefined ? {} : { chatTitle: note.chatTitle }),
		profile: note.profile,
		status: note.status,
		body: note.body,
		...(attempt ? { send: view(attempt) } : {}),
	});

	/** Record `patch`, or answer false when the journal could not. */
	function record(
		attemptId: string,
		patch: AttemptPatch,
		from: readonly SendState[],
	) {
		try {
			return journal.update(attemptId, { ...patch, updatedAt: now() }, from);
		} catch {
			return undefined;
		}
	}

	/**
	 * Beeper has this exact text: forget it, then remove its note if nobody
	 * edited it since it was claimed. A note that stays is removed by the
	 * next listing while it is still that version.
	 */
	async function settleSent(attempt: Attempt, note: string) {
		const settled = record(
			attempt.attemptId,
			{ state: 'sent', text: null, activePid: null, note },
			UNSETTLED,
		);
		if (settled === undefined) return false;
		// SAFETY: versions are opaque strings the device client gave.
		await replies.delete(
			{ id: attempt.replyId },
			{ over: attempt.replyVersion as ReplyNote['version'] },
		);
		return true;
	}

	/** A send that did not go: keep its text reviewable as a draft note when its note is gone. */
	async function restore(attempt: Attempt) {
		if (attempt.text === null) return;
		const found = await replies.get({ id: attempt.replyId });
		if (found.error?.name !== 'NotFound') return;
		await replies.create({
			id: attempt.replyId,
			chatId: attempt.chatId,
			...(attempt.chatTitle === null ? {} : { chatTitle: attempt.chatTitle }),
			profile: attempt.profile,
			status: 'draft',
			body: attempt.text,
		});
	}

	async function list(): Promise<MessagesAnswer> {
		let listed = await replies.list();
		if (listed.error !== null) return failed(describe(listed.error));
		let { items, invalid } = listed.data;
		let attempts: Attempt[];
		let withText: Attempt[];
		try {
			withText = journal.latestWithText();
			const filed = new Set([...items.map((note) => note.id), ...invalid.map((note) => note.id)]);
			let restored = false;
			for (const attempt of withText) {
				if (filed.has(attempt.replyId) || (attempt.state !== 'failed' && attempt.state !== 'not-sent')) continue;
				await restore(attempt);
				restored = true;
			}
			if (restored) {
				listed = await replies.list();
				if (listed.error !== null) return failed(describe(listed.error));
				({ items, invalid } = listed.data);
			}
			attempts = journal.ofReplies([
				...items.map((note) => note.id),
				...invalid.map((note) => note.id),
			]);
		} catch {
			return failed('The send journal could not be read.');
		}
		const latest = new Map<string, Attempt>();
		for (const attempt of attempts) latest.set(attempt.replyId, attempt);
		const shown: Reply[] = [];
		for (const note of items) {
			const attempt = latest.get(note.id);
			if (attempt?.state === 'sent' && attempt.replyVersion === note.version) {
				const removed = await replies.delete(
					{ id: note.id },
					{ over: note.version },
				);
				if (removed.error === null) continue;
			}
			shown.push(reply(note, attempt));
		}
		const filed = new Set([
			...items.map((note) => note.id),
			...invalid.map((note) => note.id),
		]);
		return {
			kind: 'replies',
			replies: shown.sort((a, b) => a.id.localeCompare(b.id)),
			invalid: invalid.map((note) => ({
				id: note.id,
				path: note.path,
				version: note.version,
				text: note.text,
				issues: note.issues,
			})),
			unfiled: withText
				.filter((attempt) => !filed.has(attempt.replyId))
				.map(view),
		};
	}

	async function save(
		request: Extract<MessagesRequest, { action: 'save' }>,
	): Promise<MessagesAnswer> {
		if (request.body.length > MAX_TEXT) return failed(tooLong);
		if (request.status === 'ready' && !request.body.trim())
			return failed('Write the reply before marking it ready.');
		if (request.over === undefined) {
			let used: boolean;
			try {
				used = journal.ofReplies([request.id]).length > 0;
			} catch {
				return failed('The send journal could not be read.');
			}
			if (used)
				return failed(
					'This reply was already sent from Messages. Save the text as a new reply.',
				);
			const created = await replies.create({
				id: request.id,
				chatId: request.chatId,
				...(request.chatTitle === undefined
					? {}
					: { chatTitle: request.chatTitle }),
				profile: request.profile,
				status: request.status,
				body: request.body,
			});
			return created.error === null
				? { kind: 'saved', reply: reply(created.data) }
				: failed(describe(created.error));
		}
		const updated = await replies.update(
			{ id: request.id },
			{ status: request.status, body: request.body },
			// SAFETY: a version this owner handed out, passed back unchanged.
			{ over: request.over as ReplyNote['version'] },
		);
		return updated.error === null
			? { kind: 'saved', reply: reply(updated.data) }
			: failed(describe(updated.error));
	}

	async function send(
		items: readonly { id: string; over: string }[],
	): Promise<SendResult[]> {
		const who = await beeper.profile();
		if (!('profile' in who))
			return items.map(({ id }) => ({
				id,
				outcome: 'skipped',
				message: `Nothing was sent: ${who.message}`,
			}));
		const results: SendResult[] = [];
		const seen = new Set<string>();
		/** Chats where an earlier reply in this send did not go, so later ones wait. */
		const held = new Set<string>();
		const skip = (id: string, message: string) =>
			results.push({ id, outcome: 'skipped', message });
		for (const { id, over } of items) {
			if (seen.has(id)) {
				skip(id, 'This reply was selected twice; it is sent once.');
				continue;
			}
			seen.add(id);
			const read = await replies.get({ id });
			if (read.error !== null) {
				skip(
					id,
					read.error.name === 'Invalid'
						? 'This reply needs repair before it can be sent.'
						: describe(read.error),
				);
				continue;
			}
			const note = read.data;
			if (note.version !== over) {
				skip(
					id,
					'This reply changed since it was selected. Review it, then select it again.',
				);
				continue;
			}
			if (note.status !== 'ready') {
				skip(id, 'Only a reply marked ready is sent.');
				continue;
			}
			if (note.profile !== who.profile) {
				skip(id, 'This reply was written for other Beeper accounts.');
				continue;
			}
			if (!note.body.trim()) {
				skip(id, 'This reply is empty.');
				continue;
			}
			if (note.body.length > MAX_TEXT) {
				skip(id, tooLong);
				continue;
			}
			if (held.has(note.chatId)) {
				skip(
					id,
					'Waiting: an earlier reply to this chat did not go, so this one was held back to keep their order.',
				);
				continue;
			}
			const at = now();
			const attempt: Attempt = {
				attemptId: crypto.randomUUID(),
				replyId: id,
				replyVersion: note.version,
				chatId: note.chatId,
				chatTitle: note.chatTitle ?? null,
				profile: note.profile,
				text: note.body,
				state: 'claimed',
				activePid: typeof process === 'undefined' ? null : process.pid,
				pendingId: null,
				routedChatId: null,
				delivery: null,
				note: null,
				claimedAt: at,
				updatedAt: at,
			};
			let blocking: Attempt | null;
			try {
				blocking = journal.claim(attempt);
			} catch {
				held.add(note.chatId);
				skip(id, 'Nothing was sent: the send could not be recorded.');
				continue;
			}
			if (blocking !== null) {
				held.add(note.chatId);
				skip(
					id,
					blocking.replyId !== id
						? 'Waiting: an earlier send to this chat has no answer from Beeper. Check it first.'
						: blocking.state === 'sent'
							? 'This exact text was already sent.'
							: 'This reply has a send to check first.',
				);
				continue;
			}
			sending.add(attempt.attemptId);
			try {
				const answer = await beeper
					.send(note.chatId, note.body)
					.catch(() => ({
						kind: 'unknown' as const,
						message: 'Beeper did not answer.',
					}));
				if (answer.kind === 'accepted') {
					const recorded = record(
						attempt.attemptId,
						{
							state: 'accepted',
							activePid: null,
							pendingId: answer.pendingId,
							routedChatId: answer.chatId,
							delivery: 'PENDING',
						},
						['claimed'],
					);
					results.push(
						recorded
							? { id, outcome: 'accepted', attemptId: attempt.attemptId }
							: {
									id,
									outcome: 'uncertain',
									attemptId: attempt.attemptId,
									message:
										'Beeper accepted it, but that could not be recorded. Check Beeper, then say what happened.',
								},
					);
					continue;
				}
				held.add(note.chatId);
				if (answer.kind === 'refused') {
					record(
						attempt.attemptId,
						{ state: 'not-sent', activePid: null, note: answer.message },
						['claimed'],
					);
					results.push({
						id,
						outcome: 'not-sent',
						attemptId: attempt.attemptId,
						message: answer.message,
					});
					continue;
				}
				const message = `${answer.message} Check the conversation in Beeper, then say whether it was sent.`;
			record(attempt.attemptId, { activePid: null, note: message }, ['claimed']);
				results.push({
					id,
					outcome: 'uncertain',
					attemptId: attempt.attemptId,
					message,
				});
			} finally {
				sending.delete(attempt.attemptId);
			}
		}
		return results;
	}

	async function check(): Promise<MessagesAnswer> {
		let accepted: Attempt[];
		try {
			accepted = journal
				.unsettled()
				.filter((attempt) => attempt.state === 'accepted');
		} catch {
			return failed('The send journal could not be read.');
		}
		for (const attempt of accepted) {
			if (attempt.pendingId === null) continue;
			const answer = await beeper.status(
				attempt.routedChatId ?? attempt.chatId,
				attempt.pendingId,
			);
			if (answer.kind === 'error') return failed(answer.message);
			switch (answer.status) {
				case 'SUCCESS':
					await settleSent(attempt, 'Beeper reported it sent.');
					break;
				case 'FAIL_PERMANENT': {
					const settled = record(
						attempt.attemptId,
						{
							state: 'failed',
							activePid: null,
							delivery: answer.status,
							note: 'Beeper could not deliver it.',
						},
						['accepted'],
					);
					if (settled) await restore(settled);
					break;
				}
				default:
					record(
						attempt.attemptId,
						{
							delivery: answer.status,
							note:
								answer.status === 'FAIL_RETRIABLE'
									? 'Beeper could not deliver it yet. Retry or delete it in Beeper, then say what happened.'
									: answer.status === null
										? 'Beeper reports no delivery status. Check the conversation in Beeper.'
										: null,
						},
						['accepted'],
					);
			}
		}
		return { kind: 'checked' };
	}

	async function resolve(
		attemptId: string,
		outcome: 'sent' | 'not-sent',
	): Promise<MessagesAnswer> {
		let attempt: Attempt | undefined;
		try {
			attempt = journal.get(attemptId);
		} catch {
			return failed('The send journal could not be read.');
		}
		if (attempt === undefined) return failed('There is no such send.');
		if (!UNSETTLED.includes(attempt.state)) return { kind: 'resolved' };
		if (sending.has(attemptId))
			return failed('Beeper is still being asked to send this. Wait for it.');
		if (attempt.activePid !== null && processIsAlive(attempt.activePid))
			return failed('Another Messages process is still asking Beeper to send this. Wait for it.');
		if (outcome === 'sent') {
			return (await settleSent(attempt, 'Checked in Beeper: sent.'))
				? { kind: 'resolved' }
				: failed('What happened could not be recorded. Try again.');
		}
		const settled = record(
			attemptId,
		{ state: 'not-sent', activePid: null, note: 'Checked in Beeper: not sent.' },
			UNSETTLED,
		);
		if (settled === undefined)
			return failed('What happened could not be recorded. Try again.');
		await restore(settled);
		return { kind: 'resolved' };
	}

	return {
		async answer(request: MessagesRequest): Promise<MessagesAnswer> {
			switch (request.action) {
				case 'connect':
				case 'disconnect':
				case 'chats':
				case 'messages':
				case 'focus':
					return beeper.request(request);
				case 'replies':
					return list();
				case 'save':
					return save(request);
				case 'remove': {
					const removed = await replies.delete(
						{ id: request.id },
						// SAFETY: a version this owner handed out, passed back unchanged.
						{ over: request.over as ReplyNote['version'] },
					);
					return removed.error === null
						? { kind: 'removed' }
						: failed(describe(removed.error));
				}
				case 'repair': {
					const repaired = await replies.replace(
						{ id: request.id },
						request.text,
						// SAFETY: a version this owner handed out, passed back unchanged.
						{ over: request.over as ReplyNote['version'] },
					);
					return repaired.error === null
						? { kind: 'saved', reply: reply(repaired.data) }
						: failed(describe(repaired.error));
				}
				case 'send':
					return { kind: 'sent', results: await send(request.items) };
				case 'check':
					return check();
				case 'resolve':
					return resolve(request.attemptId, request.outcome);
			}
		},
	};
}

/** A journal in memory: the demo's, which a reload forgets. */
export function createMemoryJournal(): Journal {
	const attempts: Attempt[] = [];
	const copy = (attempt: Attempt) => ({ ...attempt });
	return {
		claim(attempt) {
			const blocking = attempts.find(
				(other) =>
					(other.replyId === attempt.replyId &&
						UNSETTLED.includes(other.state)) ||
					(other.chatId === attempt.chatId && other.state === 'claimed') ||
					(other.replyId === attempt.replyId &&
						other.replyVersion === attempt.replyVersion &&
						other.state === 'sent'),
			);
			if (blocking) return copy(blocking);
			attempts.push(copy(attempt));
			return null;
		},
		update(attemptId, patch, from) {
			const attempt = attempts.find((other) => other.attemptId === attemptId);
			if (!attempt || !from.includes(attempt.state)) return undefined;
			Object.assign(attempt, patch);
			return copy(attempt);
		},
		get(attemptId) {
			const attempt = attempts.find((other) => other.attemptId === attemptId);
			return attempt && copy(attempt);
		},
		unsettled: () =>
			attempts
				.filter((attempt) => UNSETTLED.includes(attempt.state))
				.map(copy),
		latestWithText: () => {
			const latest = new Map<string, Attempt>();
			for (const attempt of attempts) latest.set(attempt.replyId, attempt);
			return [...latest.values()].filter((attempt) => attempt.text !== null).map(copy);
		},
		ofReplies: (replyIds) =>
			attempts
				.filter((attempt) => replyIds.includes(attempt.replyId))
				.map(copy),
	};
}
