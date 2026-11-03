import type { ThreadItem } from './protocol.js';

export function isConversationMessage(item: ThreadItem) {
	return (
		item.type === 'userMessage' ||
		(item.type === 'agentMessage' &&
			(!('phase' in item) || item.phase !== 'commentary'))
	);
}

export function segmentTurnItems(items: ThreadItem[]) {
	const segments: (
		| { kind: 'message'; item: ThreadItem }
		| { kind: 'activity'; items: ThreadItem[] }
	)[] = [];
	for (const item of items) {
		if (isConversationMessage(item)) {
			segments.push({ kind: 'message', item });
			continue;
		}
		const previous = segments.at(-1);
		if (previous?.kind === 'activity') previous.items.push(item);
		else segments.push({ kind: 'activity', items: [item] });
	}
	return segments;
}
