/**
 * NoteRepair: an invalid note repaired as text.
 *
 * Key behaviors:
 * - The note's own issues show until the person types; then what is wrong
 *   with the typed text, checked against the contract, with its line
 * - Save repair hands the typed text to `replace`; a refusal keeps the text
 *   and says why (an `Invalid` one by its issues), and a repair that lands
 *   calls `onRepaired`
 * - The repair is saved over the version the typing began from, so a change
 *   made elsewhere since is refused once; saving again replaces it
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { defineContract, type Version } from '@epicenter/definition/contract';
import { Err, Ok } from 'wellcrafted/result';

const { flushSync, mount, unmount } = await import('svelte');
const { default: NoteRepair } = await import('./note-repair.svelte');
const { cell } = await import('./reactive.test-support.svelte.js');

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
				version: 'v1' as Version,
				issues: [
					{ field: '', message: 'The frontmatter is not supported YAML' },
				],
				text: '---\ntitle: [Milk\n---\n',
			},
			async replace(text: string) {
				sent.push(text);
				return answer === 'refuse'
					? Err({
							name: 'Invalid',
							message: 'todos/a.md does not fit the contract',
							issues: [{ field: 'done', message: 'is required' }],
						})
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
		'done: is required',
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

test('a repair is saved over the version its typing began from: a change elsewhere since is refused once, then replaced', async () => {
	const target = document.createElement('div');
	document.body.append(target);
	const broken = (version: string, title: string) => ({
		path: 'todos/a.md',
		version: version as Version,
		issues: [{ field: 'done', message: 'done is missing' }],
		text: `---\ntitle: ${title}\n---\n`,
	});
	const shown = cell(broken('v1', 'Milk'));
	const sent: { text: string; over: string }[] = [];
	let repaired = 0;
	const view = mount(NoteRepair, {
		target,
		props: {
			contract: todos,
			get note() {
				return shown.value;
			},
			async replace(text: string, { over }: { over: Version }) {
				sent.push({ text, over });
				return over === shown.value.version
					? Ok(undefined)
					: Err({ name: 'Conflict', message: 'todos/a.md changed' });
			},
			onRepaired: () => repaired++,
		},
	});
	flushSync();
	const textarea = target.querySelector('textarea') as HTMLTextAreaElement;
	const save = async () => {
		(target.querySelector('form') as HTMLFormElement).requestSubmit();
		await settle();
		flushSync();
	};
	const typed = '---\ntitle: Milk\ndone: false\n---\n';
	textarea.value = typed;
	textarea.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();

	// Another program rewrites the note while the repair is typed.
	shown.value = broken('v2', 'Oat milk');
	flushSync();
	expect(textarea.value).toBe(typed);
	await save();
	expect(sent).toEqual([{ text: typed, over: 'v1' }]);
	expect(target.querySelector('[role="alert"]')?.textContent).toContain(
		'changed elsewhere',
	);
	expect(textarea.value).toBe(typed);
	expect(repaired).toBe(0);

	await save();
	expect(sent.at(-1)).toEqual({ text: typed, over: 'v2' });
	expect(repaired).toBe(1);

	await unmount(view);
	target.remove();
});
