import { folder } from '@epicenter/app';

export type Conversation = {
	chat: string;
	title: string;
	network: string;
	note?: string;
};
export type Message = {
	id: string;
	from: string;
	mine: boolean;
	text: string;
	at: string;
};
/** What Messages asks of Beeper. Only demoBeeper exists; a real adapter is unbuilt (ADR-0874). */
export type Beeper = {
	conversations(): Promise<
		(Conversation & { activity: string; preview: string })[]
	>;
	conversation(chat: string): Conversation | undefined;
	messages(chat: string): Promise<Message[]>;
	send(chat: string, text: string): Promise<{ id: string }>;
};
export const DEMO_STATE = 'beeper-demo.local.json';
const chats: Conversation[] = [
	{ chat: 'maya-chen', title: 'Maya Chen', network: 'Signal' },
	{ chat: 'community-garden', title: 'Community garden', network: 'WhatsApp' },
	{ chat: 'noah-patel', title: 'Noah Patel', network: 'Telegram' },
	{
		chat: 'harbor-ferry',
		title: 'Harbor ferry desk',
		network: 'SMS',
		note: 'Demo: a message sent here is delivered, but Beeper never confirms it, so Messages asks you to check.',
	},
];
const texts = [
	[
		'Café on Saturday?',
		'Yes, the one by the park?',
		'That sounds good. Ten o’clock?',
	],
	[
		'The seedlings are ready.',
		'I can bring a tray on Sunday.',
		'Thanks! We have space by the gate.',
	],
	[
		'Have you picked a weekend route?',
		'How about the ridge trail?',
		'Let’s start from the eastern path.',
	],
	[
		'Is the morning ferry running?',
		'Yes, the first sailing is at nine.',
		'Thank you, I will check the board.',
	],
];
const seeds = Object.fromEntries(
	chats.map((chat, i) => [
		chat.chat,
		texts[i]!.map(
			(text, n): Message => ({
				id: `seed-${i}-${n}`,
				from: n === 1 ? 'You' : chat.title,
				mine: n === 1,
				text,
				at: `2026-11-0${i + 2}T09:0${n}:00.000Z`,
			}),
		),
	]),
);
type Sent = { id: string; chat: string; text: string; at: string };
function state(text: string | undefined): { messages: Sent[] } {
	return text === undefined ? { messages: [] } : JSON.parse(text);
}
function conversation(chat: string) {
	return chats.find((row) => row.chat === chat);
}
function requireChat(chat: string) {
	if (!conversation(chat)) throw new Error(`There is no conversation ${chat}`);
}
export const demoBeeper: Beeper = {
	conversation,
	async messages(chat) {
		requireChat(chat);
		const sent = state(await folder.read(DEMO_STATE))
			.messages.filter((m) => m.chat === chat)
			.map((m) => ({
				id: m.id,
				from: 'You',
				mine: true,
				text: m.text,
				at: m.at,
			}));
		return [...seeds[chat]!, ...sent].sort((a, b) => a.at.localeCompare(b.at));
	},
	async conversations() {
		return (
			await Promise.all(
				chats.map(async (chat) => {
					const messages = await demoBeeper.messages(chat.chat);
					const last = messages.at(-1)!;
					return { ...chat, activity: last.at, preview: last.text };
				}),
			)
		).sort((a, b) => b.activity.localeCompare(a.activity));
	},
	async send(chat, text) {
		requireChat(chat);
		const id = `demo-${crypto.randomUUID()}`;
		const at = new Date().toISOString();
		await folder.update(
			DEMO_STATE,
			(before) =>
				JSON.stringify({
					messages: [...state(before).messages, { id, chat, text, at }],
				}) + '\n',
		);
		if (chat === 'harbor-ferry')
			throw new Error('Beeper did not answer within 30 seconds');
		return { id };
	},
};
