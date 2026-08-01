/**
 * Compile a set of saved entries into a practice session: the title and the one
 * user turn that open a conversation dedicated to those entries.
 *
 * Practice is a session boundary, not an interjection. The compiled turn is
 * permanent conversation memory, so sending it into whatever thread happens to
 * be open would steer that thread for good; it gets its own conversation
 * instead, and the title is what makes that conversation findable afterwards.
 *
 * It names Chinese directly (ADR-0195). Vocab teaches one language, so a prompt
 * that works around naming it only buys vagueness: the passage comes back in
 * Chinese because this turn asks for Chinese, not because the tutor guessed.
 *
 * It reads only entry text and writes nothing. The compiled passage is an
 * ordinary assistant turn in the human-owned transcript, never entry metadata
 * (ADR-0102): no entry is marked practiced, and nothing is auto-saved back.
 */

/** How a practice session opens: what its conversation is called, and its first
 * user turn. Matches the shared chat registry's `ConversationOpener`. */
export type PracticeOpening = {
	title: string;
	opening: string;
};

/** How many entries the title names before it summarizes the rest. Enough to
 * tell two practice sessions apart in the conversation list, short enough to
 * read in a sidebar row. */
const TITLE_ENTRY_COUNT = 3;

export function buildPracticeOpening(entryTexts: string[]): PracticeOpening {
	return {
		title: buildPracticeTitle(entryTexts),
		opening: buildPracticePrompt(entryTexts),
	};
}

/**
 * Name the conversation after the entries it was opened for, so the list stays
 * a way back into a past session. Without it the first-message auto-title names
 * the conversation after the first fifty characters of the compiled turn, which
 * is the same fixed string for every practice session.
 */
function buildPracticeTitle(entryTexts: string[]): string {
	const named = entryTexts
		.slice(0, TITLE_ENTRY_COUNT)
		.map((text) => text.trim())
		.filter((text) => text.length > 0);
	if (named.length === 0) return 'Practice';

	const remaining = entryTexts.length - named.length;
	const listed = named.join(', ');
	return remaining > 0
		? `Practice: ${listed} +${remaining}`
		: `Practice: ${listed}`;
}

/** The user turn itself: the verbatim entry text, plus the request that puts it
 * in context. */
function buildPracticePrompt(entryTexts: string[]): string {
	const list = entryTexts.map((text) => `- ${text}`).join('\n');
	return `Using the Chinese I'm learning below, write a short, natural passage or dialogue in Chinese that puts it in context at my level, then briefly explain the tricky parts in English.\n\nPhrases:\n${list}`;
}
