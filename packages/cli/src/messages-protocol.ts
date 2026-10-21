import { type Static, Type } from 'typebox';

const chat = Type.String({ minLength: 1 });
export const beeperRequest = Type.Union([
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
		chatId: chat,
		cursor: Type.Optional(Type.String()),
	}),
	Type.Object({
		action: Type.Literal('send'),
		chatId: chat,
		profile: chat,
		text: Type.String({ minLength: 1, maxLength: 20000 }),
	}),
	Type.Object({ action: Type.Literal('focus'), chatId: chat }),
]);
export type BeeperRequest = Static<typeof beeperRequest>;

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
export type BeeperAnswer =
	| { kind: 'connected'; profile: string }
	| { kind: 'disconnected' }
	| { kind: 'chats'; page: Page<Conversation> }
	| { kind: 'messages'; page: Page<Message> }
	| { kind: 'accepted'; pendingId: string }
	| { kind: 'focused' }
	| { kind: 'error'; message: string };
