/**
 * Which app made a folder (`madeBy`, ADR-0822): the directory's name, and,
 * where the app's view is known and the folder holds an `epicenter.json`,
 * the fit of that contract to the view.
 */
import { expect, test } from 'bun:test';
import { memoryStore } from '../device/memory-store.js';
import { type KnownApp, madeBy } from './apps.js';

const encoder = new TextEncoder();

const notes: KnownApp = {
	client: 'so.epicenter.notes',
	name: 'notes',
	view: {
		collections: {
			notes: { path: 'notes/{name}.md', fields: { title: { type: 'string' } } },
		},
	},
};
const recorder: KnownApp = {
	client: 'so.epicenter.recorder',
	name: 'recorder',
};

async function storeWith(files: Record<string, string>) {
	const store = memoryStore();
	for (const [path, text] of Object.entries(files))
		await store.put(path, encoder.encode(text), null);
	return store;
}

test("a folder named as an app names its folder is that app's", async () => {
	const store = await storeWith({ 'a.md': 'A\n' });
	expect(await madeBy('Recorder', store, [notes, recorder])).toBe(recorder);
	expect(await madeBy('Voice notes', store, [notes, recorder])).toBeNull();
});

test("a person's AGENTS.md is not evidence either way", async () => {
	const store = await storeWith({
		'AGENTS.md':
			'---\ncontract: "https://elsewhere.example/contract.json"\n---\n',
	});
	expect(await madeBy('recorder', store, [recorder])).toBe(recorder);
});

test("where the app's view is known, an epicenter.json that does not fit it is not the app's", async () => {
	const fits = await storeWith({
		'epicenter.json': JSON.stringify({
			collections: {
				notes: {
					path: 'notes/{name}.md',
					fields: { title: { type: 'string' } },
				},
			},
		}),
	});
	const other = await storeWith({
		'epicenter.json': JSON.stringify({
			collections: { recipes: { path: 'recipes/{name}.md' } },
		}),
	});
	const none = await storeWith({ 'notes/a.md': 'A\n' });
	expect(await madeBy('notes', fits, [notes])).toBe(notes);
	expect(await madeBy('notes', other, [notes])).toBeNull();
	expect(await madeBy('notes', none, [notes])).toBe(notes);
});
