/** Synthetic seed data, with no account and no credential. */
export type Message = {
	id: string;
	threadId: string;
	labelIds?: string[];
	internalDate: number;
	from: { name: string; address: string };
	to: string;
	subject: string;
	snippet: string;
	body: string;
};

export const systemLabels = [
	['INBOX', 'Inbox'],
	['UNREAD', 'Unread'],
	['STARRED', 'Starred'],
	['IMPORTANT', 'Important'],
	['TRASH', 'Trash'],
	['SPAM', 'Spam'],
	['CATEGORY_PERSONAL', 'Personal'],
	['CATEGORY_SOCIAL', 'Social'],
	['CATEGORY_PROMOTIONS', 'Promotions'],
	['CATEGORY_UPDATES', 'Updates'],
	['CATEGORY_FORUMS', 'Forums'],
].map(([id, name]) => ({ id: id!, name: name!, type: 'system' as const }));

export const labels = [
	...systemLabels,
	{ id: 'Label_1', name: 'Receipts', type: 'user' as const },
	{ id: 'Label_2', name: 'Travel', type: 'user' as const },
	{ id: 'Label_3', name: 'Family', type: 'user' as const },
];

const threads = [
	{
		name: 'Moss Bookshop',
		address: 'orders@example.com',
		subject: 'Your Moss Bookshop receipt',
		label: 'Label_1',
		lines: [
			'Thank you for ordering The Orchard Atlas.',
			'Your two books will arrive on Thursday.',
			'We packed your order with a paper bookmark.',
			'Your receipt totals 38.50. Keep it for your records.',
		],
	},
	{
		name: 'Juniper Cycles',
		address: 'bikes@example.org',
		subject: 'Bicycle service receipt',
		label: 'Label_1',
		lines: [
			'Your blue touring bike is ready for collection.',
			'We replaced the brake pads and adjusted the gears.',
			'The service total is 64.00.',
			'Please bring your collection slip on Saturday.',
		],
	},
	{
		name: 'Vale Rail',
		address: 'tickets@example.net',
		subject: 'Train booking to Willow Bay',
		label: 'Label_2',
		lines: [
			'Your booking is confirmed for carriage B, seat 14.',
			'The train leaves at 09:20 on November 15.',
			'You may bring one bicycle with a reservation.',
			'Your platform will appear on the station board.',
		],
	},
	{
		name: 'Nora Bell',
		address: 'nora@example.org',
		subject: 'Sunday lunch at the cottage',
		label: 'Label_3',
		lines: [
			'Can everyone make lunch next Sunday?',
			'I will bring the apple tart and a board game.',
			'Theo can pick you up at the station.',
			'Let us meet at noon. The kettle will be on.',
		],
	},
	{
		name: 'Orchard Letter',
		address: 'letter@example.net',
		subject: 'The monthly garden letter',
		label: 'CATEGORY_PROMOTIONS',
		lines: [
			'This month we are planting winter herbs.',
			'Our seed catalogue has new varieties of thyme.',
			'Join our fictional greenhouse tour next month.',
			'The November letter includes a guide to compost.',
		],
	},
	{
		name: 'Eli Rowan',
		address: 'eli@example.com',
		subject: 'Library workshop schedule',
		label: 'IMPORTANT',
		lines: [
			'Here is the draft schedule for the library workshop.',
			'Could you review the afternoon session?',
			'I moved the map exercise to the first hour.',
			'The final schedule is ready for Tuesday. Thank you.',
		],
	},
];
export const messages: Message[] = threads.flatMap((thread, t) =>
	thread.lines.map((line, i) => {
		const index = t * 4 + i;
		return {
			id: (index + 1).toString(16).padStart(16, '0'),
			threadId: (t + 256).toString(16).padStart(16, '0'),
			labelIds: [
				...new Set([
					index === 22 ? 'TRASH' : index === 23 ? 'SPAM' : 'INBOX',
					thread.label,
					...(i % 2 === 0 ? ['UNREAD'] : []),
					...(index === 3 ? ['STARRED'] : []),
				]),
			],
			internalDate:
				Date.parse('2026-09-01T09:00:00Z') +
				Math.round(
					(index *
						(Date.parse('2026-11-10T09:00:00Z') -
							Date.parse('2026-09-01T09:00:00Z'))) /
						23,
				),
			from: { name: thread.name, address: thread.address },
			to: 'Mira Lane <mira@example.com>',
			subject: thread.subject,
			snippet: line,
			body: `Hello Mira,\n\n${line}\n\n${thread.name}`,
		};
	}),
);
