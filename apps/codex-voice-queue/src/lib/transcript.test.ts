/**
 * Transcript tests verify message classification and ordered activity groups.
 */
import { expect, test } from 'bun:test';
import type { ThreadItem } from './protocol.js';
import {
	isConversationMessage,
	parseQuestionReply,
	segmentTurnItems,
} from './transcript.js';

test('segments messages and consecutive activity in their original order', () => {
	const user: ThreadItem = { type: 'userMessage', id: 'u', content: [] };
	const note: ThreadItem = {
		type: 'agentMessage',
		id: 'n',
		text: 'note',
		phase: 'commentary',
	};
	const unknown: ThreadItem = { type: 'futureItem' };
	const answer: ThreadItem = {
		type: 'agentMessage',
		id: 'a',
		text: 'answer',
		phase: 'final_answer',
	};
	expect(segmentTurnItems([user, note, unknown, answer, unknown])).toEqual([
		{ kind: 'message', item: user },
		{ kind: 'activity', items: [note, unknown] },
		{ kind: 'message', item: answer },
		{ kind: 'activity', items: [unknown] },
	]);
	expect(segmentTurnItems([])).toEqual([]);
});

test('commentary is activity while final and unphased answers are messages', () => {
	for (const phase of ['commentary', 'final_answer', null] as const)
		expect(
			isConversationMessage({ type: 'agentMessage', id: 'a', text: '', phase }),
		).toBe(phase !== 'commentary');
	expect(isConversationMessage({ type: 'futureItem' })).toBe(false);
});

test('parses a question answer with a trailing newline', () => {
	expect(
		parseQuestionReply(
			'<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_x\\",0]","question":"Which branch?","answer":"main"}]\n</send_user_message_question_reply>\n',
		),
	).toEqual([{ question: 'Which branch?', answer: 'main' }]);
});

test('parses three answers including free text without a trailing newline', () => {
	const replies = [
		{ question: 'Which branch?', answer: 'main' },
		{ question: 'Which check?', answer: 'Build' },
		{ question: 'Any details?', answer: 'Use my branch.\nKeep the draft.' },
	];
	expect(
		parseQuestionReply(
			`  <send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`,
		),
	).toEqual(replies);
});

test('leaves plain text and invalid question replies unchanged', () => {
	for (const text of [
		'plain text',
		'prefix <send_user_message_question_reply>[{"question":"Q","answer":"A"}]</send_user_message_question_reply>',
		'<send_user_message_question_reply>[{"question":"Q","answer":"A"}]</send_user_message_question_reply> suffix',
		'<send_user_message_question_reply>invalid json</send_user_message_question_reply>',
		...[
			'[]',
			'[{"question":"Q"}]',
			'[{"question":"Q","answer":1}]',
			'[null]',
			'["answer"]',
			'[{"question":1,"answer":"A"}]',
			'{}',
		].map(
			(json) =>
				`<send_user_message_question_reply>${json}</send_user_message_question_reply>`,
		),
	])
		expect(parseQuestionReply(text)).toBeNull();
});
