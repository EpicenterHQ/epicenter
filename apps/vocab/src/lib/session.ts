/**
 * How a deliberate session opens: the title a conversation is born with, and the
 * one user turn that starts it.
 *
 * There are three ways into Vocab and one mechanism (ADR-0195). Typing the first
 * turn composes nothing. Accepting a seed hands over a {@link SessionOpening}
 * written by hand (`./seeds.ts`), so it needs no composer. Practice is the only
 * entry that has to build one, because its opening depends on what the learner
 * selected, which is why this module holds exactly one function.
 *
 * A session boundary, not an interjection. The compiled turn is permanent
 * conversation memory, so sending it into whatever thread happens to be open
 * would steer that thread for good; it gets its own conversation instead, and
 * the title is what makes that conversation findable afterwards.
 *
 * It names Chinese directly (ADR-0195). Vocab teaches one language, so a prompt
 * that works around naming it only buys vagueness: the passage comes back in
 * Chinese because this turn asks for Chinese, not because the tutor guessed.
 *
 * It reads only entry text and writes nothing. The compiled passage is an
 * ordinary assistant turn in the human-owned transcript, never entry metadata
 * (ADR-0102): no entry is marked practiced, and nothing is auto-saved back.
 */

/** What a composed session entry hands the chat registry: what its conversation
 * is called, and its first user turn. Structurally the shared registry's
 * `ConversationOpener` with both fields required, restated here so this module
 * stays pure and dependency-free. */
export type SessionOpening = {
	title: string;
	opening: string;
};

/** How many entries the title names before it summarizes the rest. Enough to
 * tell two practice sessions apart in the conversation list, short enough to
 * read in a sidebar row. */
const TITLE_ENTRY_COUNT = 3;

/** The learner picked phrases to work on. The only session entry that reads the
 * saved pool, and it reads exactly the phrases it was handed. */
export function practiceOpening(entryTexts: string[]): SessionOpening {
	return {
		title: practiceTitle(entryTexts),
		opening: practicePrompt(entryTexts),
	};
}

/**
 * Name the conversation after the entries it was opened for, so the list stays
 * a way back into a past session. Without it the first-message auto-title names
 * the conversation after the first fifty characters of the compiled turn, which
 * is the same fixed string for every practice session.
 */
function practiceTitle(entryTexts: string[]): string {
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
function practicePrompt(entryTexts: string[]): string {
	const list = entryTexts.map((text) => `- ${text}`).join('\n');
	return `Using the Chinese I'm learning below, write a short, natural passage or dialogue in Chinese that puts it in context at my level, then briefly explain the tricky parts in English.\n\nPhrases:\n${list}`;
}
