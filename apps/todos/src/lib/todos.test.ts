/**
 * Todos File Operation Tests
 *
 * Drives the real Todos state module against a real browser folder over
 * fake IndexedDB. The file browser reaches every file, but each operation
 * keeps the rule its file needs.
 *
 * Key behaviors:
 * - A todo row deletes through its table, so its attachment goes with it
 * - A raw delete removes only the version the person confirmed
 * - Rename and delete refuse while a draft cannot save, and the draft is kept
 * - A renamed open text file keeps its editor at the new path
 * - A folder with contents is never deleted from the browser
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { openBrowserFolder } from '@epicenter/app/files';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { todosDefinition } from './definition.js';
import type { Todos } from './todos.svelte.js';

const { createTodos } = await import('./todos.svelte.ts');

const opened: Todos[] = [];
let count = 0;

async function open() {
	const folder = await openBrowserFolder({
		id: `todos-test-${count++}`,
		definition: todosDefinition,
		git: {
			author: { name: 'Test', email: 'test@example.test' },
			commitOnEdit: false,
		},
		indexedDb: { indexedDB: new IDBFactory(), IDBKeyRange },
	});
	const todos = createTodos(folder);
	opened.push(todos);
	await todos.refreshAll();
	return todos;
}

afterEach(async () => {
	for (const todos of opened.splice(0)) await todos.close();
});

async function text(todos: Todos, path: string) {
	const read = await todos.folder.files.read(path);
	return read.error ? undefined : new TextDecoder().decode(read.data.bytes);
}

function textEditor(todos: Todos) {
	const selection = todos.selection;
	if (selection?.kind !== 'file' || selection.file.kind !== 'text')
		throw new Error(
			`Expected an open text file, got ${JSON.stringify(selection)}`,
		);
	return selection.file.editor;
}

test('a todo row deletes through its table, taking its attachment with it', async () => {
	const todos = await open();
	expect(await todos.create('Milk')).toBeUndefined();
	const path = todos.selectedPath!;
	const attachment = path.replace(/\.md$/, '.png');
	await todos.folder.files.write(attachment, new Uint8Array([0x89, 0x50, 0]), {
		expected: 'absent',
	});
	await todos.refresh();

	const deletion = await todos.deletionFor(path);
	expect(deletion.data).toMatchObject({ kind: 'todo', entry: { attachment } });
	expect(await todos.remove(deletion.data!)).toBeUndefined();
	expect(await text(todos, path)).toBeUndefined();
	expect(await text(todos, attachment)).toBeUndefined();
	expect(todos.selectedPath).toBeUndefined();
});

test('a raw delete removes only the version that was confirmed', async () => {
	const todos = await open();
	await todos.folder.files.write('notes.txt', 'first', { expected: 'absent' });
	await todos.refresh();
	const deletion = await todos.deletionFor('notes.txt');
	expect(deletion.data?.kind).toBe('file');

	await todos.folder.files.write('notes.txt', 'second', { expected: 'any' });
	const problem = await todos.remove(deletion.data!);
	expect(problem).toContain('changed after it was read');
	expect(await text(todos, 'notes.txt')).toBe('second');
});

test('rename and delete refuse while a draft cannot save, and keep the draft', async () => {
	const todos = await open();
	await todos.folder.files.write('notes.txt', 'saved', { expected: 'absent' });
	await todos.refresh();
	await todos.open('notes.txt');
	const editor = textEditor(todos);

	await todos.folder.files.write('notes.txt', 'theirs', { expected: 'any' });
	editor.input('mine');
	await editor.save();
	expect(editor.saveState.kind).toBe('conflict');

	expect(await todos.rename('notes.txt', 'renamed.txt')).toBe(
		'Save or discard the open edits first.',
	);
	expect((await todos.deletionFor('notes.txt')).error).toBe(
		'Save or discard the open edits first.',
	);
	expect(editor.buffer).toBe('mine');
	expect(await text(todos, 'notes.txt')).toBe('theirs');

	await editor.keepMine();
	expect(editor.saveState.kind).toBe('saved');
	expect(await text(todos, 'notes.txt')).toBe('mine');
});

test('a renamed open text file keeps its editor at the new path', async () => {
	const todos = await open();
	await todos.folder.files.write('notes.txt', 'hello', { expected: 'absent' });
	await todos.refresh();
	await todos.open('notes.txt');
	const editor = textEditor(todos);

	expect(await todos.rename('notes.txt', 'hello.txt')).toBeUndefined();
	expect(todos.selectedPath).toBe('hello.txt');
	expect(textEditor(todos)).toBe(editor);
	expect(editor.path).toBe('hello.txt');
	expect(await text(todos, 'notes.txt')).toBeUndefined();

	editor.input('hello again');
	await editor.save();
	expect(await text(todos, 'hello.txt')).toBe('hello again');
});

test('non-text files open as details, and todo rows open their todo editor', async () => {
	const todos = await open();
	await todos.folder.files.write('photo.png', new Uint8Array([0x89, 0, 1]), {
		expected: 'absent',
	});
	expect(await todos.create('Bread')).toBeUndefined();
	const row = todos.selectedPath!;
	await todos.refresh();

	await todos.open('photo.png');
	expect(todos.selection).toMatchObject({
		kind: 'file',
		file: { kind: 'binary', size: 3 },
	});
	await todos.open(row);
	expect(todos.selection?.kind).toBe('todo');
});

test('a folder is deleted from the browser only when it is empty', async () => {
	const todos = await open();
	expect(await todos.createFolder('', 'docs')).toBeUndefined();
	expect(await todos.createFile('docs', 'a.txt')).toBeUndefined();
	expect((await todos.deletionFor('docs')).error).toContain(
		'Only empty folders',
	);

	const file = await todos.deletionFor('docs/a.txt');
	expect(await todos.remove(file.data!)).toBeUndefined();
	const folder = await todos.deletionFor('docs');
	expect(folder.data).toEqual({ kind: 'folder', path: 'docs' });
	expect(await todos.remove(folder.data!)).toBeUndefined();
	expect(todos.listing?.directories).not.toContain('docs');
});
