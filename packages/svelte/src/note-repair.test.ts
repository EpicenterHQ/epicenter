/**
 * NoteRepair: an invalid note repaired as text, over a folder in memory.
 *
 * Key behaviors:
 * - The note's own issues show until the person types; then what is wrong
 *   with the typed text, checked against the contract, with its line
 * - Save repair writes the typed text through the note's editor, as typed:
 *   text that still does not read is saved and the note stays invalid with
 *   its new text; text that reads repairs it and calls `onRepaired`
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { defineContract } from '@epicenter/definition/contract';
import { home, openFolder } from '@epicenter/folder';
import { memoryFiles } from '@epicenter/folder/memory';

const { flushSync, mount, unmount } = await import('svelte');
const { default: NoteRepair } = await import('./note-repair.svelte');
const { cell } = await import('./reactive.test-support.svelte.js');

const todos = defineContract({
	collections: {
		todos: {
			path: 'todos/{id}.md',
			fields: { title: { type: 'string' }, done: { type: 'boolean' } },
			required: ['title', 'done'],
		},
	},
});

async function until(check: () => boolean) {
	for (let turn = 0; turn < 300 && !check(); turn++) await Bun.sleep(5);
	expect(check()).toBe(true);
}

test('problems follow the typed text, and Save repair writes it as typed until it reads', async () => {
	const folder = openFolder(
		todos,
		home({ site: 'https://todos.epicenter.so' }),
	);
	await memoryFiles(folder).write('todos/a.md', '---\ntitle: [Milk\n---\n');
	const stop = folder.todos.subscribe(() => {});
	await until(() => folder.todos.invalid().length === 1);
	const shown = cell(folder.todos.invalid()[0]!);
	const target = document.createElement('div');
	document.body.append(target);
	let repaired = 0;
	const view = mount(NoteRepair, {
		target,
		props: {
			contract: todos,
			get note() {
				return shown.value;
			},
			edit: folder.todos.edit({ id: 'a' }),
			onRepaired: () => repaired++,
		},
	});
	flushSync();
	const problems = () =>
		[...target.querySelectorAll('[aria-label="Problems"] li')].map(
			(item) => item.textContent,
		);
	const textarea = target.querySelector('textarea') as HTMLTextAreaElement;
	const type = (text: string) => {
		textarea.value = text;
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
	};
	const save = async () => {
		(target.querySelector('form') as HTMLFormElement).requestSubmit();
		await Bun.sleep(20);
		flushSync();
	};

	expect(textarea.getAttribute('aria-label')).toBe('Text of todos/a.md');
	expect(textarea.value).toBe('---\ntitle: [Milk\n---\n');
	expect(problems()[0]).toStartWith('The frontmatter is not supported YAML');

	type('---\ntitle: Milk\n---\n');
	expect(problems()).toEqual(['done is missing']);
	await save();
	expect(memoryFiles(folder).read('todos/a.md')).toBe(
		'---\ntitle: Milk\n---\n',
	);
	expect(repaired).toBe(1);
	await until(
		() => folder.todos.invalid()[0]?.text === '---\ntitle: Milk\n---\n',
	);
	shown.value = folder.todos.invalid()[0]!;
	flushSync();
	expect(textarea.value).toBe('---\ntitle: Milk\n---\n');

	type('---\ntitle: Milk\ndone: 3\n---\n');
	expect(problems()[0]).toStartWith('Line 3: done does not conform');
	type('---\ntitle: Milk\ndone: false\n---\n');
	expect(problems()).toEqual([]);
	await save();
	expect(memoryFiles(folder).read('todos/a.md')).toBe(
		'---\ntitle: Milk\ndone: false\n---\n',
	);
	expect(repaired).toBe(2);
	await until(() => folder.todos.invalid().length === 0);
	expect(folder.todos.get({ id: 'a' })?.title).toBe('Milk');

	await unmount(view);
	target.remove();
	stop();
});

test('typing while a save lands stays typed, and a save the folder will not make keeps the typing', async () => {
	let land!: () => void;
	let refuse!: (error: Error) => void;
	const edit = {
		text: '',
		landed: () =>
			new Promise<void>((resolve, reject) => {
				land = resolve;
				refuse = reject;
			}),
	};
	const target = document.createElement('div');
	document.body.append(target);
	let repaired = 0;
	const view = mount(NoteRepair, {
		target,
		props: {
			contract: todos,
			note: {
				path: 'todos/a.md',
				issues: [],
				text: '---\ntitle: [Milk\n---\n',
			},
			edit,
			onRepaired: () => repaired++,
		},
	});
	flushSync();
	const textarea = target.querySelector('textarea') as HTMLTextAreaElement;
	const type = (text: string) => {
		textarea.value = text;
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
	};
	const submit = () => {
		(target.querySelector('form') as HTMLFormElement).requestSubmit();
		flushSync();
	};
	const saveButton = () =>
		[...target.querySelectorAll('button')].find(
			(button) => button.textContent === 'Save repair',
		) as HTMLButtonElement;

	type('---\ntitle: Milk\n---\n');
	submit();
	expect(edit.text).toBe('---\ntitle: Milk\n---\n');
	type('---\ntitle: Milk\ndone: true\n---\n');
	land();
	await Bun.sleep(0);
	flushSync();
	expect(textarea.value).toBe('---\ntitle: Milk\ndone: true\n---\n');
	expect(repaired).toBe(1);

	submit();
	refuse(new Error('FolderClosed'));
	await Bun.sleep(0);
	flushSync();
	expect(textarea.value).toBe('---\ntitle: Milk\ndone: true\n---\n');
	expect(saveButton().disabled).toBe(false);
	expect(repaired).toBe(1);

	await unmount(view);
	target.remove();
});
