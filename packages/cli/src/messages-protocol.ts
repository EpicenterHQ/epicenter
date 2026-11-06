/**
 * What Messages' page, `epicenter messages --json`, and the local program
 * say to each other: one JSON operation in, one answer out.
 *
 * Beeper operations read conversations; the staging operations read and
 * write reply notes in the Messages folder, and `send` is the only
 * operation that posts a message. It names each reply with the version
 * that was reviewed, so what is sent is exactly what was selected.
 */
import type { ConformanceIssue, Version } from '@epicenter/definition/contract';
import { type Static, Type } from 'typebox';

const id = Type.String({ minLength: 1 });
/** Beeper's limit for one text message, in characters. */
export const MAX_TEXT = 20_000;

export const messagesRequest = Type.Union([
	Type.Object({
		action: Type.Literal('connect'),
		token: Type.Optional(Type.String({ minLength: 1 })),
	}),
	Type.Object({ action: Type.Literal('disconnect') }),
	Type.Object({
		action: Type.Literal('chats'),
		cursor: Type.Optional(Type.String()),
	}),
	Type.Object({
		action: Type.Literal('messages'),
		chatId: id,
		cursor: Type.Optional(Type.String()),
	}),
	Type.Object({ action: Type.Literal('focus'), chatId: id }),
	Type.Object({ action: Type.Literal('replies') }),
	Type.Object({
		action: Type.Literal('save'),
		id,
		/** The version the edit began from; absent to create the reply. */
		over: Type.Optional(id),
		chatId: id,
		chatTitle: Type.Optional(Type.String()),
		profile: id,
		status: Type.Union([Type.Literal('draft'), Type.Literal('ready')]),
		body: Type.String({ maxLength: MAX_TEXT }),
	}),
	Type.Object({ action: Type.Literal('remove'), id, over: id }),
	Type.Object({
		action: Type.Literal('repair'),
		id,
		over: id,
		text: Type.String(),
	}),
	Type.Object({
		action: Type.Literal('send'),
		items: Type.Array(Type.Object({ id, over: id }), {
			minItems: 1,
			maxItems: 100,
		}),
	}),
	Type.Object({ action: Type.Literal('check') }),
	Type.Object({
		action: Type.Literal('resolve'),
		attemptId: id,
		outcome: Type.Union([Type.Literal('sent'), Type.Literal('not-sent')]),
	}),
]);
export type MessagesRequest = Static<typeof messagesRequest>;
/** The operations Beeper answers alone, with no reply note involved. */
export type BeeperRead = Extract<
	MessagesRequest,
	{ action: 'connect' | 'disconnect' | 'chats' | 'messages' | 'focus' }
>;

/** The small, app-facing representation, independent of SDK pagination classes. */
export type Conversation = {
	id: string;
	title: string;
	network: string;
	preview: string;
	activity: string;
};
export type Message = {
	id: string;
	text: string;
	sender: string;
	mine: boolean;
	timestamp: string;
	attachment: boolean;
	status?: string;
};
export type Page<T> = { items: T[]; cursor: string | null };

/**
 * Where one send attempt stands, as the journal records it:
 *
 * - `claimed`: recorded before Beeper was asked, with no answer since.
 *   While its process is still asking it is `sending`; otherwise nobody
 *   knows whether Beeper has it, and only a person's check settles it.
 * - `accepted`: Beeper took it and gave a pending id, which `check` follows.
 * - `sent`: Beeper reported it delivered, or a person checked it was sent.
 * - `failed`: Beeper reported it could not be delivered.
 * - `not-sent`: Beeper refused it, or a person checked it was not sent.
 */
export type SendState = 'claimed' | 'accepted' | 'sent' | 'failed' | 'not-sent';

export type Send = {
	attemptId: string;
	replyId: string;
	chatId: string;
	chatTitle: string | null;
	profile: string;
	state: SendState;
	/** The text claimed; null once it was sent, when Beeper holds it. */
	text: string | null;
	/** Beeper's last reported delivery status for an accepted send. */
	delivery: string | null;
	/** Why it stands where it does, in words for the person. */
	note: string | null;
	claimedAt: string;
	/** A `claimed` send this process is still asking Beeper about. */
	sending: boolean;
};

export type Reply = {
	id: string;
	version: Version;
	chatId: string;
	chatTitle?: string;
	profile: string;
	status: 'draft' | 'ready';
	body: string;
	/** The latest send of this reply, when it has one. */
	send?: Send;
};

/** A file in `replies/` that does not read as a reply, kept for repair. */
export type InvalidReply = {
	id: string;
	path: string;
	version: Version;
	text: string | null;
	issues: ConformanceIssue[];
};

/** What happened to one selected reply. */
export type SendResult =
	| { id: string; outcome: 'accepted'; attemptId: string }
	| {
			id: string;
			outcome: 'uncertain' | 'not-sent';
			attemptId: string;
			message: string;
	  }
	| { id: string; outcome: 'skipped'; message: string };

export type MessagesAnswer =
	| { kind: 'connected'; profile: string }
	| { kind: 'disconnected' }
	| { kind: 'chats'; page: Page<Conversation> }
	| { kind: 'messages'; page: Page<Message> }
	| { kind: 'focused' }
	| {
			kind: 'replies';
			replies: Reply[];
			invalid: InvalidReply[];
			/** Unsettled sends whose reply note is gone. */
			unfiled: Send[];
	  }
	| { kind: 'saved'; reply: Reply }
	| { kind: 'removed' }
	| { kind: 'sent'; results: SendResult[] }
	| { kind: 'checked' }
	| { kind: 'resolved' }
	| { kind: 'error'; message: string };
