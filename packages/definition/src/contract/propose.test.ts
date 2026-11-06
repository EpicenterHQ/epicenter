import { expect, test } from 'bun:test';
import { checkContract } from './check.js';
import { compileContract } from './contract.js';
import { EPICENTER_JSON_SCHEMA, proposeContract } from './propose.js';

const note = (fields: string) => `---\n${fields}\n---\nBody\n`;

test('notes propose a collection with fields typed by their values, and files beside them another', () => {
	const files = [
		{
			path: 'recordings/standup.md',
			text: note('title: "Standup"\nduration: 12\ndone: false'),
		},
		{
			path: 'recordings/retro.md',
			text: note('title: "Retro"\nduration: 3.5\ntags: ["team"]'),
		},
		{ path: 'recordings/standup.webm' },
		{ path: 'recordings/retro.webm' },
		{ path: 'photos/a.jpg' },
		{ path: 'photos/b.png' },
		{ path: 'AGENTS.md' },
		{ path: 'epicenter.json' },
		{ path: '.epicenter/synced.json' },
	];
	const { contract, left } = proposeContract({ title: 'Studio', files });
	expect(contract).toEqual({
		$schema: EPICENTER_JSON_SCHEMA,
		title: 'Studio',
		collections: {
			recordings: {
				path: 'recordings/{name}.md',
				fields: {
					done: { type: 'boolean' },
					duration: { type: 'number' },
					tags: { type: 'array' },
					title: { type: 'string' },
				},
			},
			photos: { path: 'photos/{name}.{ext}' },
			recordings_files: { path: 'recordings/{name}.webm' },
		},
	});
	expect(left).toEqual([]);
	// The folder fits what was proposed for it.
	expect(compileContract(contract).error).toBeNull();
	expect(checkContract(contract, files).data).toEqual([]);
});

test('what no collection can hold is left out, with the reason', () => {
	const { contract, left } = proposeContract({
		title: 'Mixed',
		files: [
			{ path: 'readme.txt' },
			{ path: 'notes/a.md', text: '---\ntitle: [unclosed\n---\n' },
			{ path: 'notes/b.md', text: note('name: "b"\nmood: "ok"') },
		],
	});
	expect(contract.collections).toEqual({
		notes: { path: 'notes/{name}.md', fields: { mood: { type: 'string' } } },
	});
	expect(left.map(({ path }) => path)).toEqual([
		'readme.txt',
		'notes/a.md',
		'notes/',
	]);
});

test('an empty folder proposes a complete folder with no collections', () => {
	const { contract } = proposeContract({ title: 'Empty', files: [] });
	expect(contract.collections).toEqual({});
	expect(compileContract(contract).error).toBeNull();
});
