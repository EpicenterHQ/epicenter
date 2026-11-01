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
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAVES as WORKER_SAVES } from './device/opfs-worker.js';
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
