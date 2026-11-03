import type { ThreadItem } from './protocol.js';

/** Codex wraps answers to request_user_input_async in this tag. */
export function parseQuestionReply(
	text: string,
): { question: string; answer: string }[] | null {
	const match =
		/^<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>$/.exec(
			text.trim(),
		);
	if (!match?.[1]) return null;
	try {
		const entries: unknown = JSON.parse(match[1].trim());
		if (!Array.isArray(entries) || !entries.length) return null;
		const replies: { question: string; answer: string }[] = [];
		for (const entry of entries) {
			if (
				entry === null ||
				typeof entry !== 'object' ||
				typeof entry.question !== 'string' ||
				typeof entry.answer !== 'string'
			)
				return null;
			replies.push({ question: entry.question, answer: entry.answer });
		}
		return replies;
	} catch {
		return null;
	}
}

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
