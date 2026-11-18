/**
 * Nested Field Tests
 *
 * A field's JSON Schema may describe an object or an array of objects (a
 * chat's focus words, a message's parts), so every layer that reads or
 * writes front matter must treat a nested value as one value: whole, typed,
 * and located when it does not fit.
 *
 * Key behaviors:
 * - A contract with nested object fields compiles, and `checkContract`
 *   locates a nested failure at its field's line
 * - A nested value is one JSON value on its field's line, written and read
 *   back whole
 */
import { describe, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { newNote, parseNote } from '../note.js';
import { checkContract } from './check.js';
import { compileContract, defineContract } from './contract.js';

const tutor = defineContract({
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

const chat = (...focus: string[]) =>
	`---\ncreatedAt: "2026-10-31T09:00:00.000Z"\nfocus: [${focus.join(', ')}]\n---\n`;
const lucid = '{"entryId": "a", "text": "lucid"}';
const candid = '{"entryId": "b", "text": "candid"}';

describe('the contract and the check', () => {
	test('nested object fields compile', () => {
		expectOk(compileContract(tutor));
	});

	test('notes whose nested values fit have no issues', () => {
		expect(
			expectOk(
				checkContract(tutor, [
					{ path: 'chats/c1.md', text: chat(lucid, candid) },
					{
						path: 'messages/c1/m1.md',
						text: '---\nrole: "assistant"\nparts: [{"type": "text", "text": "Hello"}, {"input": {"query": "lucid"}, "type": "tool-call"}]\n---\n',
					},
				]),
			),
		).toEqual([]);
	});

	test('a nested failure is located at its field', () => {
		const issues = expectOk(
			checkContract(tutor, [
				{
					path: 'chats/c1.md',
					text: chat(lucid, '{"entryId": "b", "text": 7}'),
				},
			]),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			path: 'chats/c1.md',
			collection: 'chats',
			field: 'focus',
			// The `focus` line, the note's third.
			line: 3,
		});
		expect(issues[0]?.message).toContain('focus/1/text');
	});

	test('a nested array past its bounds, and a part of no declared kind, are issues', () => {
		const issues = expectOk(
			checkContract(tutor, [
				{
					path: 'chats/c1.md',
					text: chat(),
				},
				{
					path: 'messages/c1/m1.md',
					text: '---\nrole: "user"\nparts: [{"type": "image"}]\n---\n',
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
				line: 3,
			});
		expect(part.map((issue) => issue.message).join('\n')).toContain('anyOf');
	});
});

describe('a nested value as written', () => {
	test('is one JSON value on its line, and reads back whole', () => {
		const written = newNote(
			{
				focus: [{ entryId: 'a', text: 'lucid' }],
				createdAt: '2026-10-31T09:00:00.000Z',
			},
			'',
			['createdAt', 'focus'],
		);
		expect(written).toBe(chat(lucid));
		expect(expectOk(parseNote(written)).fields).toEqual({
			createdAt: '2026-10-31T09:00:00.000Z',
			focus: [{ entryId: 'a', text: 'lucid' }],
		});
	});
});
