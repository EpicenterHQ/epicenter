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

/** Browser builds cannot access the native Beeper connection. No HTTP fallback. */
export async function requestBeeper(
	request: BeeperRequest,
): Promise<BeeperAnswer> {
	if (import.meta.env.EPICENTER_HOST !== '1')
		return {
			kind: 'error',
			message:
				'Connect Beeper from Messages in the Epicenter desktop app. This browser build uses demo conversations only.',
		};
	const { invoke } = await import('@tauri-apps/api/core');
	try {
		return JSON.parse(
			await invoke<string>('messages_beeper', {
				request: JSON.stringify(request),
			}),
		) as BeeperAnswer;
	} catch {
		return {
			kind: 'error',
			message:
				'The Beeper connection did not respond. If you were sending, check Beeper before sending again.',
		};
	}
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
