/**
 * State Layout Tests
 *
 * Where a folder's unfinished writes live is spelled once per language:
 * `state.ts` here and `state.rs` in the folder core. Both read
 * `fixtures/state-layout.json`, so a rename on one side fails the other's
 * suite. The OPFS worker, which imports nothing, keeps its own copy of
 * `.epicenter/saves`, held to the same fixture here.
 *
 * Key behaviors:
 * - The directory and its `saves` part match the shared layout
 * - `savesDirectory` builds the shared layout's path
 * - The OPFS worker stages where `savesDirectory` says
 * - The OPFS worker names and ages its staged files as every host does
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isStaleScratch } from './boundary.js';
import {
	isStaleSave,
	stagedName,
	SAVES as WORKER_SAVES,
} from './device/opfs-worker.js';
import { SAVES, STATE_DIRECTORY, savesDirectory } from './state.js';

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

test('the OPFS worker stages in the shared layout', () => {
	expect(WORKER_SAVES.join('/')).toBe(layout.savesDirectory);
});

test('the OPFS worker names and ages its staged files as every host does', () => {
	const hour = 60 * 60 * 1000;
	const name = stagedName();
	const made = Number.parseInt(name.slice(0, name.indexOf('-')), 36);
	for (const now of [made + hour, made + hour + 1]) {
		expect(isStaleSave(name, now)).toBe(isStaleScratch(name, now));
	}
	expect(isStaleScratch(name, made + hour + 1)).toBe(true);
	const engine = '0123456789abcdef0123456789abcdef';
	for (const foreign of [
		'notes.md',
		'a',
		`${made.toString(36)}-${crypto.randomUUID()}`,
		`${made.toString(36)}-${engine}`,
		`${made.toString(36)}-${engine}-0-1`,
	]) {
		expect(isStaleSave(foreign, Number.MAX_SAFE_INTEGER)).toBe(false);
		expect(isStaleScratch(foreign, Number.MAX_SAFE_INTEGER)).toBe(false);
	}
});
