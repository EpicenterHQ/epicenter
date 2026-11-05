/**
 * State Layout Tests
 *
 * Where a folder's unfinished writes live is spelled once per language:
 * `state.ts` here and `state.rs` in the folder core. Both read
 * `fixtures/state-layout.json`, so a rename on one side fails the other's
 * suite.
 *
 * Key behaviors:
 * - The directory and its `saves` part match the shared layout
 * - `savesDirectory` builds the shared layout's path
 * - Staged names carry their age in the grammar the desktop shell sweeps
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	isStaleSave,
	SAVES,
	STATE_DIRECTORY,
	savesDirectory,
	scratchName,
} from './state.js';

/** The layout `state.rs` reads too. */
const layout = JSON.parse(
	readFileSync(
		join(
			import.meta.dir,
			'../../tauri-plugin-epicenter-folder/fixtures/state-layout.json',
		),
		'utf8',
	),
) as {
	directory: string;
	saves: string;
	savesDirectory: string;
};

test('the directory and its saves part are the shared layout', () => {
	expect([STATE_DIRECTORY, SAVES]).toEqual([layout.directory, layout.saves]);
});

test('savesDirectory builds the shared layout', () => {
	expect(savesDirectory('/folder')).toBe(`/folder/${layout.savesDirectory}`);
});

test('staged names carry their age, and only a staged name is ever stale', () => {
	const hour = 60 * 60 * 1000;
	const name = scratchName();
	const made = Number.parseInt(name.slice(0, name.indexOf('-')), 36);
	expect(isStaleSave(name, made + hour)).toBe(false);
	expect(isStaleSave(name, made + hour + 1)).toBe(true);
	const engine = '0123456789abcdef0123456789abcdef';
	const now = Date.now().toString(36);
	for (const foreign of [
		'notes.md',
		'a',
		`${now}-${crypto.randomUUID()}`,
		`${now}-${engine}`,
		`${now}-${engine}-0-1`,
	])
		expect(isStaleSave(foreign, Number.MAX_SAFE_INTEGER)).toBe(false);
});
