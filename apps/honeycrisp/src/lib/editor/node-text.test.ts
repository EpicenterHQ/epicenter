/**
 * Reading a note's title and preview off the node itself.
 *
 * These replace the assertions that used to run against a ProseMirror document
 * built by `fragmentToPm`. The subject is now the nested `Y.Type` (ADR-0295),
 * so the tests fill a real note through the real Markdown codec and read what
 * a list would read.
 */
import { expect, test } from 'bun:test';
import { InstantString } from '@epicenter/app/field';
import { openMemory } from '@epicenter/app/memory';
import { pmToFragment } from '@y/prosemirror';
import { honeycrispDefinition } from '../data.js';
import { parseNoteBody } from './markdown.js';
import { notePreview, noteTitle } from './node-text.js';

const AT = InstantString.fromDate(new Date('2026-08-10T00:00:00.000Z'));

/** One note whose body holds `markdown`, through the codec the editor uses. */
async function noteWith(markdown: string) {
	const data = await openMemory(honeycrispDefinition);
	const note = data.tables.notes.create({
		folderId: null,
		title: '',
		pinned: false,
		createdAt: AT,
		updatedAt: AT,
		deletedAt: null,
	});
	const content = data.tables.notes.get(note.id);
	if (content === undefined) throw new Error('the note has no content');
	if (markdown !== '') {
		pmToFragment(parseNoteBody(markdown), content.content as never);
	}
	return content.content;
}

test('the title is the first block', async () => {
	const body = await noteWith('# Groceries\n\nbuy milk');
	expect(noteTitle(body)).toBe('Groceries');
});

test('the preview separates adjacent blocks with a space', async () => {
	const body = await noteWith('Hello\n\nWorld');
	expect(notePreview(body)).toBe('Hello World');
});

test('an empty note has neither', async () => {
	const body = await noteWith('');
	expect(noteTitle(body)).toBe('');
	expect(notePreview(body)).toBe('');
});

test('the title is capped at 80 characters', async () => {
	const body = await noteWith('a'.repeat(200));
	expect(noteTitle(body)).toHaveLength(80);
});

test('the preview is capped at 100 characters', async () => {
	const body = await noteWith(`${'a'.repeat(200)}\n\nnever reached`);
	const preview = notePreview(body);
	expect(preview).toHaveLength(100);
	expect(preview).not.toContain('never reached');
});

test('a long note is not walked to answer a short question', async () => {
	// The claim `node-text.ts` rests on: `slice` returns as soon as it has the
	// count it was asked for, so the cost is the answer's size and not the
	// note's. Asserted as a ratio rather than a duration, because a wall-clock
	// threshold on a shared runner is a flake.
	const short = await noteWith('# Title\n\nbody');
	const long = await noteWith(
		`# Title\n\n${Array.from({ length: 4000 }, (_, i) => `paragraph ${i}`).join('\n\n')}`,
	);
	expect(noteTitle(long)).toBe('Title');

	const time = (read: () => void): number => {
		for (let i = 0; i < 50; i++) read();
		const started = performance.now();
		for (let i = 0; i < 200; i++) read();
		return performance.now() - started;
	};
	const shortMs = time(() => notePreview(short));
	const longMs = time(() => notePreview(long));
	// A whole-document read would be roughly a thousand times this note's size.
	expect(longMs).toBeLessThan(shortMs * 20 + 50);
});
