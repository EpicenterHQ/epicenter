/**
 * Proactive conversation seeds: the app's answer to a blank thread.
 *
 * A seed is a topic, not a drill (ADR-0195). It never reads the saved pool: if
 * it did, accepting a seed would be Practice wearing a friendlier name, and the
 * two would collapse into one thing with a worse name. That independence is
 * structural here rather than enforced, because a seed is fixed text with no
 * input at all.
 *
 * App-owned data, not a table and not a model call. Nothing records which seed
 * was shown or taken, so the same seed can come round again; that is the
 * accepted cost of storing no session state. A seed a learner curates and
 * reorders would be the trigger to make this a record.
 *
 * Each seed is already a {@link SessionOpening}, so accepting one is
 * `createConversation(seed)` with nothing composed in between. The opening line
 * is written the way a learner would actually type it: a short first-person
 * Chinese sentence, then the English clause that sets the level. It is a real
 * user turn in the transcript, so the thread stays a replayable memory.
 */

import type { SessionOpening } from './session.js';

/** The hand-written seed list. Titles are short and distinct, because a title is
 * how a conversation is found again in the list. */
export const CONVERSATION_SEEDS: readonly SessionOpening[] = [
	{
		title: 'My weekend',
		opening:
			"我想聊聊我的周末。Let's talk about my weekend in Chinese, and keep it simple enough for me to follow.",
	},
	{
		title: 'Ordering food',
		opening:
			"我想练习点菜。Pretend you're the waiter at a small restaurant and let's order in Chinese.",
	},
	{
		title: 'Where I live',
		opening:
			'我想说说我住的地方。Ask me about where I live and keep the conversation going in Chinese.',
	},
	{
		title: 'Asking directions',
		opening:
			"我想练习问路。Let's role-play asking for directions in a Chinese city.",
	},
	{
		title: 'What I do',
		opening:
			'我想聊聊我的工作。Ask me what I do, and help me say it more naturally in Chinese.',
	},
	{
		title: 'My family',
		opening:
			"我想介绍我的家人。Let's talk about my family in Chinese, and correct me when I get something wrong.",
	},
	{
		title: 'Something I watched',
		opening:
			"我最近看了一部电影。Let's chat about it in Chinese, and ask me questions to keep me talking.",
	},
	{
		title: 'Shopping',
		opening:
			"我想练习买东西。Pretend you're a shopkeeper and let's haggle a little in Chinese.",
	},
];

/**
 * Draw distinct seeds to offer. Random rather than fixed so a blank thread does
 * not always make the same three suggestions, and unrecorded, so this is the
 * whole of seed selection: nothing here reads or writes durable state.
 *
 * Returns fewer than asked only when the list is shorter than `count`.
 */
export function sampleSeeds(count: number): SessionOpening[] {
	const pool = [...CONVERSATION_SEEDS];
	const drawn: SessionOpening[] = [];
	// Drawing without replacement: each pick leaves the pool, so the loop
	// terminates on the pool running out even if more were asked for.
	while (drawn.length < count && pool.length > 0) {
		const [seed] = pool.splice(Math.floor(Math.random() * pool.length), 1);
		if (seed) drawn.push(seed);
	}
	return drawn;
}
