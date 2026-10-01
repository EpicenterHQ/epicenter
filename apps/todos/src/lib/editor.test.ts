/**
 * Todo Editor Tests
 *
 * Drives the real todo editor runes module (compiled with Svelte's module
 * compiler) against a recording table. The editor keeps its buffer and
 * accepted baseline separate and never crashes on source it cannot interpret.
 *
 * Key behaviors:
 * - Typing an unresolvable YAML alias shows a frontmatter issue; nothing throws
 * - A structured edit on that source is refused and the buffer is unchanged
 * - Saving writes the exact buffer against the captured baseline
 * - Typing during a save stays dirty after the save is accepted
 *
 * See also:
 * - `packages/app/src/files/markdown.test.ts` for the shared source preparation
 * - `todos.test.ts` for raw text drafts against a real browser folder
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { Entry, FileTable } from '@epicenter/app/files';
import { captureVersion, readSource } from '@epicenter/app/files';
import type { TodoFields } from './definition.js';

const { createTodoEditor, patchTodo } = await import('./editor.svelte.ts');

const encoder = new TextEncoder();

async function entryFor(source: string): Promise<Entry<TodoFields>> {
	return {
		path: 'todos/milk.md',
		stem: 'milk',
		source,
		version: await captureVersion(encoder.encode(source)),
		attachment: undefined,
		fields: { title: 'Milk', done: false },
		body: '',
		issues: undefined,
	};
}

function recordingTable(release?: Promise<void>) {
	const writes: { baseline: string; source: string }[] = [];
	const table = {
		async writeSource(baseline: Entry<TodoFields>, source: string) {
			writes.push({ baseline: baseline.source, source });
			await release;
			return { data: await entryFor(source), error: null };
		},
		async get() {
			return { data: undefined, error: null };
		},
	} as unknown as FileTable<TodoFields>;
	return { table, writes };
}

test('an unresolvable alias typed into the source is an issue, not a crash', async () => {
	const { table, writes } = recordingTable();
	const original = '---\ntitle: Milk\ndone: false\n---\n';
	const editor = createTodoEditor(table, await entryFor(original), () => {});
	const broken = '---\ntitle: *missing\ndone: false\n---\nbody\n';

	editor.input(broken);
	const parsed = readSource(editor.buffer);
	expect(parsed.values).toBeUndefined();
	expect(parsed.body).toBe('body\n');
	expect(parsed.issues[0]?.message).toContain('Unresolved alias');

	expect(patchTodo(editor, { fields: { done: true } })).toBe(false);
	expect(editor.refusal).toContain('edit the complete source');
	expect(editor.buffer).toBe(broken);

	await editor.save();
	expect(writes).toEqual([{ baseline: original, source: broken }]);
	expect(editor.baseline.source).toBe(broken);
	expect(editor.dirty).toBe(false);
	editor.dispose();
});

test('typing during a save stays dirty after the earlier generation is accepted', async () => {
	let release!: () => void;
	const { table, writes } = recordingTable(
		new Promise<void>((resolve) => {
			release = resolve;
		}),
	);
	const original = '---\ntitle: Milk\ndone: false\n---\n';
	const editor = createTodoEditor(table, await entryFor(original), () => {});
	patchTodo(editor, { body: 'A\n' });
	const saving = editor.save();
	patchTodo(editor, { body: 'A and B\n' });
	release();
	await saving;
	expect(writes[0]?.source).toBe(`${original}A\n`);
	expect(editor.baseline.source).toBe(`${original}A\n`);
	expect(editor.buffer).toBe(`${original}A and B\n`);
	expect(editor.dirty).toBe(true);
	editor.dispose();
});

test('same-byte observations refresh attachment metadata without replacing typing', async () => {
	const { table } = recordingTable();
	const original = await entryFor('---\ntitle: Milk\ndone: false\n---\n');
	const editor = createTodoEditor(table, original, () => {});
	editor.input(`${original.source}mine\n`);
	editor.observe({ ...original, attachment: 'todos/milk.png' });
	expect(editor.baseline.attachment).toBe('todos/milk.png');
	expect(editor.buffer).toBe(`${original.source}mine\n`);
	expect(editor.dirty).toBe(true);
	editor.dispose();
});
