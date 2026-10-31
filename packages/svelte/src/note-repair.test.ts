/**
 * NoteRepair: an invalid note repaired as text.
 *
 * Key behaviors:
 * - The note's own issues show until the person types; then what is wrong
 *   with the typed text, checked against the contract, with its line
 * - Save repair hands the typed text to `replace`; a refusal keeps the text
 *   and says why, and a repair that lands calls `onRepaired`
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { defineContract } from '@epicenter/definition/contract';
import { Err, Ok } from 'wellcrafted/result';

const { flushSync, mount, unmount } = await import('svelte');
const { default: NoteRepair } = await import('./note-repair.svelte');

const todos = defineContract({
	name: 'todos',
	collections: {
		todos: {
			path: 'todos/{id}.md',
			fields: { title: { type: 'string' }, done: { type: 'boolean' } },
			required: ['title', 'done'],
		},
	},
});

const settle = () => new Promise((done) => setTimeout(done, 0));

test('problems follow the typed text, and Save repair hands it to replace', async () => {
	const target = document.createElement('div');
	document.body.append(target);
	const sent: string[] = [];
	let answer: 'refuse' | 'land' = 'refuse';
	let repaired = 0;
	const view = mount(NoteRepair, {
		target,
		props: {
			contract: todos,
			note: {
				path: 'todos/a.md',
				issues: [
					{ field: '', message: 'The frontmatter is not supported YAML' },
				],
				text: '---\ntitle: [Milk\n---\n',
			},
			async replace(text: string) {
				sent.push(text);
				return answer === 'refuse'
					? Err({ message: 'todos/a.md does not fit the contract' })
					: Ok(undefined);
			},
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
		await settle();
		flushSync();
	};

	expect(textarea.getAttribute('aria-label')).toBe('Text of todos/a.md');
	expect(textarea.value).toBe('---\ntitle: [Milk\n---\n');
	expect(problems()).toEqual(['The frontmatter is not supported YAML']);

	type('---\ntitle: Milk\n---\n');
	expect(problems()).toEqual(['done is missing']);
	await save();
	expect(sent).toEqual(['---\ntitle: Milk\n---\n']);
	expect(target.querySelector('[role="alert"]')?.textContent).toContain(
		'does not fit the contract',
	);
	expect(textarea.value).toBe('---\ntitle: Milk\n---\n');
	expect(repaired).toBe(0);

	type('---\ntitle: Milk\ndone: 3\n---\n');
	expect(problems()[0]).toStartWith('Line 3: done does not conform');
	type('---\ntitle: Milk\ndone: false\n---\n');
	expect(problems()).toEqual([]);
	answer = 'land';
	await save();
	expect(sent.at(-1)).toBe('---\ntitle: Milk\ndone: false\n---\n');
	expect(repaired).toBe(1);
	expect(target.querySelector('[role="alert"]')).toBeNull();

	await unmount(view);
	target.remove();
});
