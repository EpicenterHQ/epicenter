import type {
	BeeperAnswer,
	BeeperRequest,
	Conversation,
	Message,
} from '@epicenter/cli/messages-protocol';

export type Backend = {
	mode: 'demo' | 'live';
	profile: string;
	request(request: BeeperRequest): Promise<BeeperAnswer>;
};

/**
 * The live Beeper connection. Only a native build can reach Beeper Desktop,
 * through `epicenter messages --json`; this browser build has no such build
 * and no HTTP fallback, so it answers with demo conversations only.
 */
export async function requestBeeper(
	_request: BeeperRequest,
): Promise<BeeperAnswer> {
	return {
		kind: 'error',
		message:
			'Live Beeper needs a desktop build of Messages. This browser build uses demo conversations only.',
	};
}

/** Entirely fictional conversations. Sending here cannot reach a network. */
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
	return {
		mode: 'demo',
		profile: 'fictional-v1',
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
		async request(request) {
			switch (request.action) {
				case 'connect':
					return { kind: 'connected', profile: 'fictional-v1' };
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
				case 'send': {
					if (shouldFail) {
						shouldFail = false;
						return {
							kind: 'error',
							message:
								'Demo: the send outcome is unknown. Your draft is retained.',
						};
					}
					return {
						kind: 'accepted',
						pendingId: append(request.chatId, request.text, true).id,
					};
				}
			}
		},
	};
}
