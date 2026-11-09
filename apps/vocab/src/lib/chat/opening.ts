import type { ChatMessage } from '@epicenter/ai';

/**
 * The tutor's opening: a chat with no messages yet asks with one transient
 * learner turn, which is never saved, so the tutor speaks first. The
 * conversation's `prepare`.
 */
export function tutorOpening(messages: ChatMessage[]): ChatMessage[] {
	return messages.length > 0
		? messages
		: [{ role: 'user', content: 'Begin our conversation.' }];
}
