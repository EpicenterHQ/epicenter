import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';

import { expectOk } from 'wellcrafted/testing';

import { honeycrispDefinition } from '../data.js';
import { parseNoteBody, serializeNoteBody } from './markdown.js';
import { noteSchema } from './schema.js';

/** Parse, serialize, and hand back the text: the fixpoint a note must hold. */
function roundTrip(markdown: string): string {
	return serializeNoteBody(parseNoteBody(markdown));
}

describe('the note body Markdown codec', () => {
	test('body text round-trips through its own export', () => {
		const markdown = [
			'# Groceries',
			'',
			'A list with **bold**, *emphasis*, `code`, and a [link](https://example.com).',
			'',
			'> quoted',
			'',
			'* milk',
			'* eggs',
			'',
			'1. first',
			'2. second',
		].join('\n');
		expect(roundTrip(markdown)).toBe(markdown);
	});

	test('strikethrough survives both directions', () => {
		const markdown = 'keep ~~gone~~ keep';
		const parsed = parseNoteBody(markdown);
		const strikes: string[] = [];
		parsed.descendants((node) => {
			if (node.marks.some((mark) => mark.type.name === 'strike')) {
				strikes.push(node.textContent);
			}
		});
		expect(strikes).toEqual(['gone']);
		expect(roundTrip(markdown)).toBe(markdown);
	});

	test('a task list round-trips with its checked state', () => {
		const markdown = ['- [x] milk', '- [ ] eggs'].join('\n');
		const parsed = parseNoteBody(markdown);
		const items: boolean[] = [];
		parsed.descendants((node) => {
			if (node.type.name === 'taskItem')
				items.push(Boolean(node.attrs.checked));
		});
		expect(items).toEqual([true, false]);
		expect(roundTrip(markdown)).toBe(markdown);
	});

	test('a list mixing task markers and plain items stays a bullet list', () => {
		const markdown = ['* [x] milk', '* eggs'].join('\n');
		const parsed = parseNoteBody(markdown);
		let taskItems = 0;
		parsed.descendants((node) => {
			if (node.type.name === 'taskItem') taskItems += 1;
		});
		// Half-marked is not a task list; the markers stay visible text, which is
		// also exactly what the file showed. The serializer escapes the literal
		// bracket on the way out, so the contract here is content, not bytes: the
		// re-emitted file parses back to the same document.
		expect(taskItems).toBe(0);
		expect(parseNoteBody(roundTrip(markdown)).eq(parsed)).toBe(true);
	});

	test('underline keeps its text and loses its mark', () => {
		const underlined = noteSchema.node('doc', null, [
			noteSchema.node('paragraph', null, [
				noteSchema.text('kept', [noteSchema.mark('underline')]),
			]),
		]);
		expect(serializeNoteBody(underlined)).toBe('kept');
	});

	test('the declared codec round-trips a body through an attached node', () => {
		const codec = honeycrispDefinition.tables.notes.body;
		const markdown = [
			'# Title',
			'',
			'Body with **bold**.',
			'',
			'- [x] done',
		].join('\n');

		// The codec builds its own node and hands it back (ADR-0296, amended), so
		// nothing here mints or attaches one first.
		const built = expectOk(codec.decode(markdown));
		// Integrated before it is read, the way `create` does it. A detached node
		// accumulates its writes in a prelim delta and READS AS EMPTY until
		// `_integrate` replays them, so encoding one straight out of the codec
		// would report an empty note and pass nothing.
		const document = new Y.Doc();
		try {
			const row = document.get('tables:notes');
			document.transact(() => {
				row.setAttr('content' as never, built as never);
			});
			const node = row.getAttr('content' as never) as Y.Node;
			// What `decode` produced is what `encode` reads back: the pair is the
			// identity on the text.
			expect(codec.encode(node)).toBe(markdown);
			expect(node.toString()).toContain('Title');
		} finally {
			document.destroy();
		}
	});

	test('the node it returns is fresh, so two rows never share one', () => {
		const codec = honeycrispDefinition.tables.notes.body;
		const one = expectOk(codec.decode('# One'));
		const two = expectOk(codec.decode('# Two'));
		expect(one).not.toBe(two);
		// Detached until `create` integrates it. A node that already belongs to a
		// document is what `createRow` refuses, because two rows given one node
		// would share one body.
		expect(one.doc).toBeNull();
	});
});
