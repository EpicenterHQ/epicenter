/**
 * Nested Field Tests
 *
 * A field's JSON Schema may describe an object or an array of objects (a
 * chat's focus words, a message's parts), so every layer that reads or
 * writes front matter must treat a nested value as one value: whole, typed,
 * located when it does not fit, written in one house style, and merged as
 * one key.
 *
 * Key behaviors:
 * - A contract with nested object fields compiles, and `checkContract`
 *   locates a nested failure at the line of the value inside the field
 * - House style writes nested mappings in block YAML with their keys sorted,
 *   and formatting its own text changes nothing
 * - The merge takes a nested value whole: one side's change to it lands
 *   beside the other side's change to another key, and when both change it
 *   the later arrival's value wins, with no block, so the note still reads
 */
import { describe, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { settle } from '../merge/settle.js';
import { formatNote, parseRowSource } from '../note/index.js';
import { checkContract } from './check.js';
import { compileContract, defineContract } from './contract.js';

const tutor = defineContract({
	name: 'tutor',
	collections: {
		chats: {
			path: 'chats/{id}.md',
			fields: {
				createdAt: { type: 'string' },
				focus: {
					type: 'array',
					minItems: 1,
					maxItems: 3,
					items: {
						type: 'object',
						properties: {
							entryId: { type: 'string' },
							text: { type: 'string' },
						},
						required: ['entryId', 'text'],
					},
				},
			},
			required: ['createdAt', 'focus'],
		},
		messages: {
			path: 'messages/{chat}/{id}.md',
			fields: {
				role: { enum: ['user', 'assistant'] },
				parts: {
					type: 'array',
					items: {
						anyOf: [
							{
								type: 'object',
								properties: {
									type: { const: 'text' },
									text: { type: 'string' },
								},
								required: ['type', 'text'],
							},
							{
								type: 'object',
								properties: { type: { const: 'tool-call' }, input: {} },
								required: ['type', 'input'],
							},
						],
					},
				},
			},
			required: ['role', 'parts'],
		},
	},
});

const chat = (focus: string) =>
	`---\ncreatedAt: "2026-10-31T09:00:00.000Z"\nfocus:\n${focus}---\n`;
const lucid = '  - entryId: a\n    text: lucid\n';
const candid = '  - entryId: b\n    text: candid\n';

describe('the contract and the check', () => {
	test('nested object fields compile', () => {
		expectOk(compileContract(tutor));
	});

	test('notes whose nested values fit have no issues', () => {
		expect(
			expectOk(
				checkContract(tutor, [
					{ path: 'chats/c1.md', text: chat(lucid + candid) },
					{
						path: 'messages/c1/m1.md',
						text: '---\nrole: assistant\nparts:\n  - type: text\n    text: Hello\n  - input:\n      query: lucid\n    type: tool-call\n---\n',
					},
				]),
			),
		).toEqual([]);
	});

	test('a nested failure is located at the value inside the field', () => {
		const issues = expectOk(
			checkContract(tutor, [
				{
					path: 'chats/c1.md',
					text: chat(`${lucid}  - entryId: b\n    text: 7\n`),
				},
			]),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			path: 'chats/c1.md',
			collection: 'chats',
			field: 'focus',
			// `text: 7`, the second item's text, on the note's seventh line.
			line: 7,
		});
		expect(issues[0]?.message).toContain('focus/1/text');
	});

	test('a nested array past its bounds, and a part of no declared kind, are issues', () => {
		const issues = expectOk(
			checkContract(tutor, [
				{
					path: 'chats/c1.md',
					text: chat('  []\n').replace(':\n  []', ': []'),
				},
				{
					path: 'messages/c1/m1.md',
					text: '---\nrole: user\nparts:\n  - type: image\n---\n',
				},
			]),
		);
		const [bounds, ...part] = issues;
		expect(bounds).toMatchObject({ path: 'chats/c1.md', field: 'focus' });
		// A union reports why each branch refused the part, all at its line.
		expect(part.length).toBeGreaterThan(0);
		for (const issue of part)
			expect(issue).toMatchObject({
				path: 'messages/c1/m1.md',
				field: 'parts',
				line: 4,
			});
		expect(part.map((issue) => issue.message).join('\n')).toContain('anyOf');
	});
});

describe('house style', () => {
	test('nested mappings are block YAML with sorted keys, and formatting is stable', () => {
		const written = expectOk(
			formatNote(
				'---\nfocus: [{text: lucid, entryId: a}]\ncreatedAt: "2026-10-31T09:00:00.000Z"\n---\n',
				['createdAt', 'focus'],
			),
		);
		expect(written).toBe(chat(lucid));
		expect(expectOk(formatNote(written, ['createdAt', 'focus']))).toBe(written);
		expect(expectOk(parseRowSource(written)).document.fields).toEqual({
			createdAt: '2026-10-31T09:00:00.000Z',
			focus: [{ entryId: 'a', text: 'lucid' }],
		});
	});
});

describe('the merge', () => {
	const parties = {
		current: { author: 'main', time: 't1' },
		incoming: { author: 'alice/laptop', time: 't2' },
	};
	const withTitle = (title: string, focus: string) =>
		`---\ntitle: ${title}\nfocus:\n${focus}---\nNotes\n`;

	test('a change to a nested value lands beside a change to another key', () => {
		const base = withTitle('Words', lucid);
		expect(
			settle(
				base,
				withTitle('My words', lucid),
				withTitle('Words', lucid + candid),
				{
					parties,
				},
			),
		).toEqual({ text: withTitle('My words', lucid + candid), blocks: false });
		expect(
			settle(
				base,
				withTitle('Words', lucid + candid),
				withTitle('My words', lucid),
				{
					parties,
				},
			),
		).toEqual({ text: withTitle('My words', lucid + candid), blocks: false });
	});

	test('a nested value both sides changed takes the later arrival’s, whole, with no block', () => {
		const settled = settle(
			withTitle('Words', lucid),
			withTitle('Words', candid),
			withTitle('Words', `${lucid}  - entryId: c\n    text: nuance\n`),
			{ parties },
		);
		expect(settled).toEqual({
			text: withTitle('Words', `${lucid}  - entryId: c\n    text: nuance\n`),
			blocks: false,
		});
		expectOk(parseRowSource(settled.text as string));
	});
});
