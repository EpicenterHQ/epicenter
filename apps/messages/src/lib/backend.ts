/**
 * Where the page's operations go: Messages' local program on this computer
 * (`scripts/serve.ts`), which keeps the reply notes, the send journal and
 * the Beeper token, or the fictional demo, which runs the same send owner
 * in memory. Every view takes one `Backend` and asks it the same
 * operations.
 */
import {
	createMemoryJournal,
	createMessages,
} from '@epicenter/cli/messages-outbox';
import type {
	Conversation,
	Message,
	MessagesAnswer,
	MessagesRequest,
} from '@epicenter/cli/messages-protocol';
import { createMemoryReplies } from './demo/replies.js';

export type Backend = {
	kind: 'local' | 'demo';
	request(request: MessagesRequest): Promise<MessagesAnswer>;
};

/** What the page says when no local program answers. */
export const NOT_SERVED_HERE =
	'Your replies and live Beeper need Messages running on this computer: run `bun run --cwd apps/messages start` and open http://127.0.0.1:5188.';

async function post(request: MessagesRequest) {
	const response = await fetch('/messages', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(request),
	});
	if (
		!response.ok ||
		!response.headers.get('content-type')?.startsWith('application/json')
	)
		return null;
	// SAFETY: the local program answers only with a `MessagesAnswer`.
	return (await response.json()) as MessagesAnswer;
}

/**
 * The local program: every operation goes to it, and it answers each the
 * way `epicenter messages --json` does. Served any other way (`vite dev`, a
 * static host), nothing answers.
 */
export const local: Backend = {
	kind: 'local',
	async request(request) {
		try {
			return (
				(await post(request)) ?? { kind: 'error', message: NOT_SERVED_HERE }
			);
		} catch {
			return {
				kind: 'error',
				message:
					request.action === 'send'
						? 'Messages on this computer did not answer. Your replies are still in the folder; check Beeper before sending again.'
						: 'Could not reach Messages on this computer.',
			};
		}
	},
};

/** Whether the local program answers this page. */
export async function servedLocally() {
	try {
		return (await post({ action: 'replies' })) !== null;
	} catch {
		return false;
	}
}

/** The profile the demo's fictional accounts have. */
export const DEMO_PROFILE = 'fictional-v1';

/**
 * Entirely fictional conversations, with replies and sends in memory. The
 * send owner is the real one; its Beeper is a fake that cannot reach a
 * network.
 */
export function createDemoBackend(): Backend & {
	incoming(): void;
	failNext(): void;
} {
	const conversations: Conversation[] = [
		{
			id: 'demo-maya',
			title: 'Maya Chen',
			network: 'Signal',
			preview: 'Shall we try the new café on Saturday?',
			activity: '2026-10-20T09:05:00Z',
		},
		{
			id: 'demo-garden',
			title: 'Community garden',
			network: 'WhatsApp',
			preview: 'The seedlings are ready to collect.',
			activity: '2026-10-20T08:00:00Z',
		},
		{
			id: 'demo-noah',
			title: 'Noah Patel',
			network: 'Telegram',
			preview: 'Here is the route for the weekend.',
			activity: '2026-10-19T12:00:00Z',
		},
	];
	const messages = new Map<string, Message[]>(
		conversations.map((chat) => [
			chat.id,
			[
				{
					id: `${chat.id}-older`,
					text: 'Thanks for organizing this.',
					sender: 'You',
					mine: true,
					timestamp: '2026-10-19T08:00:00Z',
					attachment: false,
				},
				{
					id: `${chat.id}-last`,
					text: chat.preview,
					sender: chat.title,
					mine: false,
					timestamp: chat.activity,
					attachment: chat.id === 'demo-garden' || chat.id === 'demo-noah',
				},
			],
		]),
	);
	let shouldFail = false;
	function append(chatId: string, text: string, mine: boolean) {
		const message: Message = {
			id: crypto.randomUUID(),
			text,
			sender: mine ? 'You' : 'Maya Chen',
			mine,
			timestamp: new Date().toISOString(),
			attachment: false,
			status: 'SUCCESS',
		};
		messages.get(chatId)?.push(message);
		const chat = conversations.find((candidate) => candidate.id === chatId);
		if (chat) {
			chat.preview = text;
			chat.activity = message.timestamp;
		}
		return message;
	}
	const owner = createMessages({
		replies: createMemoryReplies(),
		journal: createMemoryJournal(),
		beeper: {
			async request(request) {
				switch (request.action) {
					case 'connect':
						return { kind: 'connected', profile: DEMO_PROFILE };
					case 'disconnect':
						return { kind: 'disconnected' };
					case 'chats':
						return {
							kind: 'chats',
							page: {
								items: structuredClone(conversations).sort((a, b) =>
									b.activity.localeCompare(a.activity),
								),
								cursor: null,
							},
						};
					case 'messages':
						return {
							kind: 'messages',
							page: {
								items: structuredClone(messages.get(request.chatId) ?? []),
								cursor: null,
							},
						};
					case 'focus':
						return { kind: 'focused' };
				}
			},
			async profile() {
				return { profile: DEMO_PROFILE };
			},
			async send(chatId, text) {
				if (shouldFail) {
					shouldFail = false;
					return {
						kind: 'unknown',
						message: 'Demo: Beeper did not answer.',
					};
				}
				return {
					kind: 'accepted',
					pendingId: append(chatId, text, true).id,
					chatId,
				};
			},
			async status(chatId, pendingId) {
				const found = messages
					.get(chatId)
					?.some((message) => message.id === pendingId);
				return { kind: 'status', status: found ? 'SUCCESS' : null };
			},
		},
	});
	return {
		kind: 'demo',
		request: (request) => owner.answer(request),
		incoming() {
			append(
				'demo-maya',
				'Demo incoming message: Saturday at ten works for me.',
				false,
			);
		},
		failNext() {
			shouldFail = true;
		},
	};
}
