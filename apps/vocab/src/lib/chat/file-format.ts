/**
 * A codec for Vocab's proposed text-only chat files. Speaker headings are file
 * grammar even inside Markdown fences, so an unclosed fence cannot hide later
 * turns from the app. The caller still owns conditional writes.
 */
import { isMap, isScalar, parseDocument, stringify } from 'yaml';

export type ChatTurn = { role: 'Learner' | 'Tutor'; text: string };
export type ChatFile = {
	createdAt: string;
	updatedAt: string;
	focus: { entryId: string; text: string }[];
	turns: ChatTurn[];
};

const marker = /^# (Learner|Tutor)$/gm;
const reservedLine = /^(\\*)# (Learner|Tutor)(?=\r?\n|$)/gm;
const escapedLine = /^(\\+)# (Learner|Tutor)(?=\r?\n|$)/gm;

function encodeText(text: string): string {
	return text.replace(
		reservedLine,
		(_line, escapes: string, role: string) => `${escapes}\\# ${role}`,
	);
}

function decodeText(text: string): string {
	return text.replace(
		escapedLine,
		(_line, escapes: string, role: string) => `${escapes.slice(1)}# ${role}`,
	);
}

function parseSource(source: string) {
	if (/^<<<<<<< .+$/m.test(source) && /^>>>>>>> .+$/m.test(source))
		throw new Error('Chat has unresolved merge markers');
	const frame = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
	if (!frame) throw new Error('Chat frontmatter is missing or malformed');
	const yaml = frame[1];
	const body = frame[2];
	if (yaml === undefined || body === undefined)
		throw new Error('Chat frontmatter is malformed');
	const document = parseDocument(yaml, { strict: true, uniqueKeys: true });
	if (document.errors.length || !isMap(document.contents))
		throw new Error('Chat frontmatter cannot be interpreted');
	const fields: unknown = document.toJS();
	if (!fields || typeof fields !== 'object' || Array.isArray(fields))
		throw new Error('Chat frontmatter must be an object');
	return { yaml, body, document, fields: fields as Record<string, unknown> };
}

/** Read a chat without changing source; reject files unsafe for typed edits. */
export function parseChatFile(source: string): ChatFile {
	const { body, fields } = parseSource(source);
	if (fields.format !== 'vocab-chat/1')
		throw new Error('Unsupported Vocab chat format');
	if (
		typeof fields.createdAt !== 'string' ||
		Number.isNaN(Date.parse(fields.createdAt)) ||
		typeof fields.updatedAt !== 'string' ||
		Number.isNaN(Date.parse(fields.updatedAt))
	)
		throw new Error('Chat dates are missing or invalid');
	if (
		!Array.isArray(fields.focus) ||
		fields.focus.length > 3 ||
		!fields.focus.every(
			(item: unknown) =>
				item !== null &&
				typeof item === 'object' &&
				'entryId' in item &&
				typeof item.entryId === 'string' &&
				'text' in item &&
				typeof item.text === 'string',
		)
	)
		throw new Error('Chat focus is missing or invalid');
	if (/^\n*$/.test(body))
		return {
			createdAt: fields.createdAt,
			updatedAt: fields.updatedAt,
			focus: fields.focus as ChatFile['focus'],
			turns: [],
		};
	const boundaries = [...body.matchAll(marker)];
	if (
		boundaries.length === 0 ||
		!/^\n*$/.test(body.slice(0, boundaries[0]?.index))
	)
		throw new Error('Chat body has no valid first turn');
	const turns: ChatTurn[] = [];
	for (const [index, boundary] of boundaries.entries()) {
		const role = boundary[1];
		const start = (boundary.index ?? 0) + boundary[0].length;
		const end = boundaries[index + 1]?.index ?? body.length;
		const framed = body.slice(start, end);
		const contentStart = framed.startsWith('\n\n')
			? 2
			: framed.startsWith('\n')
				? 1
				: 0;
		const contentEnd = framed.endsWith('\n\n')
			? -2
			: index < boundaries.length - 1 && framed.endsWith('\n')
				? -1
				: undefined;
		if (
			contentStart === 0 ||
			(index < boundaries.length - 1 && contentEnd === undefined)
		)
			throw new Error('Chat turn spacing is malformed');
		if (role !== 'Learner' && role !== 'Tutor')
			throw new Error('Chat turn role is invalid');
		turns.push({
			role,
			text: decodeText(framed.slice(contentStart, contentEnd)),
		});
	}
	return {
		createdAt: fields.createdAt,
		updatedAt: fields.updatedAt,
		focus: fields.focus as ChatFile['focus'],
		turns,
	};
}

export function createChatFile(
	focus: ChatFile['focus'],
	createdAt: string,
): string {
	if (focus.length < 1 || focus.length > 3)
		throw new Error('Choose one to three saved expressions');
	const source = `---\n${stringify({
		format: 'vocab-chat/1',
		createdAt,
		updatedAt: createdAt,
		focus,
	}).trimEnd()}\n---\n\n`;
	parseChatFile(source);
	return source;
}

/** Prepare a turn append while preserving unrelated frontmatter source. */
export function appendChatTurn(
	source: string,
	turn: ChatTurn,
	updatedAt: string,
): string {
	const before = parseChatFile(source);
	if (Number.isNaN(Date.parse(updatedAt)))
		throw new Error('Chat update time is invalid');
	const parsed = parseSource(source);
	if (!isMap(parsed.document.contents))
		throw new Error('Chat frontmatter cannot be interpreted');
	const pair = parsed.document.contents.items.find(
		(item) => isScalar(item.key) && item.key.value === 'updatedAt',
	);
	if (!pair || !isScalar(pair.value) || !pair.value.range)
		throw new Error('Chat update time cannot be patched safely');
	const [start, end] = pair.value.range;
	const patched = `${parsed.yaml.slice(0, start)}${stringify(updatedAt).trimEnd()}${parsed.yaml.slice(end)}`;
	const prefix =
		before.turns.length === 0
			? '\n'
			: `${parsed.body}${parsed.body.endsWith('\n\n') ? '' : '\n\n'}`;
	const body = `${prefix}# ${turn.role}\n\n${encodeText(turn.text)}\n\n`;
	const result = `---\n${patched}\n---\n${body}`;
	const checked = parseChatFile(result);
	if (checked.turns.length !== before.turns.length + 1)
		throw new Error('Chat append changed existing turns');
	return result;
}
