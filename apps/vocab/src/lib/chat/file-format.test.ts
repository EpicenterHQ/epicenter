/**
 * Vocab chat file format tests.
 *
 * A readable Markdown conversation must recover the tutor's exact text and
 * preserve source outside an appended turn.
 *
 * Key behaviors:
 * - Tutor-first and unanswered learner chats remain readable.
 * - Reserved speaker headings round-trip inside arbitrary message text.
 * - A changed readable file can receive a later completed turn.
 */
import { expect, test } from 'bun:test';
import {
	appendChatTurn,
	createChatFile,
	parseChatFile,
} from './file-format.js';

const start = '2026-09-29T10:00:00Z';
const later = '2026-09-29T10:01:00Z';
const newest = '2026-09-29T10:02:00Z';
const focus = [{ entryId: 'w123', text: 'serendipity' }];

test('a chat exists with focus before the tutor speaks', () => {
	const source = createChatFile(focus, start);
	expect(parseChatFile(source)).toEqual({
		createdAt: start,
		updatedAt: start,
		focus,
		turns: [],
	});
	const opened = appendChatTurn(
		source,
		{ role: 'Tutor', text: 'Have you found something by accident?' },
		later,
	);
	expect(parseChatFile(opened).turns.map((turn) => turn.role)).toEqual([
		'Tutor',
	]);
});

test('speaker headings, escapes, and Markdown fences round-trip as tutor text', () => {
	const text = [
		'',
		'# Learner',
		'\\# Tutor',
		'\\\\# Learner',
		'# Tutor\r',
		'```md',
		'# Tutor',
		'```',
		'## A normal heading',
		'',
		'',
	].join('\n');
	const source = appendChatTurn(
		createChatFile(focus, start),
		{ role: 'Tutor', text },
		later,
	);
	expect(parseChatFile(source).turns).toEqual([{ role: 'Tutor', text }]);
	expect(source).toContain('\\# Learner');
	expect(source).toContain('\\# Tutor\n```');
});

test('a learner turn stays saved without a completed tutor answer', () => {
	const source = appendChatTurn(
		createChatFile(focus, start),
		{ role: 'Learner', text: 'What does it mean?' },
		later,
	);
	expect(parseChatFile(source).turns).toEqual([
		{ role: 'Learner', text: 'What does it mean?' },
	]);
});

test('an editor may trim final blank lines before the app appends another turn', () => {
	const first = appendChatTurn(
		createChatFile(focus, start),
		{ role: 'Tutor', text: 'First answer.' },
		later,
	).trimEnd();
	expect(parseChatFile(first).turns).toEqual([
		{ role: 'Tutor', text: 'First answer.' },
	]);
	const second = appendChatTurn(
		first,
		{ role: 'Learner', text: 'Follow-up question.' },
		newest,
	);
	expect(parseChatFile(second).turns.map((turn) => turn.text)).toEqual([
		'First answer.',
		'Follow-up question.',
	]);
});

test('appending patches recency without replacing unfamiliar frontmatter', () => {
	const original = createChatFile(focus, start).replace(
		'updatedAt:',
		'agentField: { source: "outside" }\nupdatedAt:',
	);
	const changed = appendChatTurn(
		original,
		{ role: 'Learner', text: 'A question' },
		later,
	);
	expect(changed).toContain('agentField: { source: "outside" }');
	expect(changed).toContain(`updatedAt: ${later}`);
	expect(parseChatFile(changed).turns).toHaveLength(1);
});

test('a changed readable source receives the completed answer', () => {
	const base = appendChatTurn(
		createChatFile(focus, start),
		{ role: 'Learner', text: 'What does it mean?' },
		later,
	);
	const external = appendChatTurn(
		base,
		{ role: 'Learner', text: 'I changed the question.' },
		newest,
	);
	const saved = appendChatTurn(
		external,
		{ role: 'Tutor', text: 'It means a happy accident.' },
		newest,
	);
	expect(parseChatFile(external).turns.map((turn) => turn.text)).toEqual([
		'What does it mean?',
		'I changed the question.',
	]);
	expect(parseChatFile(saved).turns.map((turn) => turn.text)).toEqual([
		'What does it mean?',
		'I changed the question.',
		'It means a happy accident.',
	]);
});

test('merge markers in a body cannot become a tutor prompt', () => {
	const source = appendChatTurn(
		createChatFile(focus, start),
		{ role: 'Learner', text: 'What does this mean?' },
		later,
	).replace(
		'What does this mean?',
		'<<<<<<< phone\nWhat does this mean?\n=======\nWhat changed?\n>>>>>>> desktop',
	);
	expect(() => parseChatFile(source)).toThrow('unresolved merge markers');
	expect(() =>
		appendChatTurn(source, { role: 'Tutor', text: 'An answer' }, newest),
	).toThrow('unresolved merge markers');
});

test('malformed source is preserved for repair instead of accepting an app append', () => {
	const malformed = createChatFile(focus, start).replace(
		'format: vocab-chat/1',
		'format: other-format',
	);
	expect(() => parseChatFile(malformed)).toThrow(
		'Unsupported Vocab chat format',
	);
	expect(() =>
		appendChatTurn(malformed, { role: 'Learner', text: 'New text' }, later),
	).toThrow('Unsupported Vocab chat format');
	expect(malformed).toContain('format: other-format');
});
