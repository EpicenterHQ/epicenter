/**
 * Reserved Name Tests
 *
 * The names Epicenter keeps beside a folder's files are spelled once per
 * language: `state.ts` here and `state.rs` in the folder core. Both read
 * `fixtures/reserved-names.json`, so a rename on one side fails the other's
 * suite.
 *
 * Key behaviors:
 * - A staged save and a recording in progress are reserved; nothing else is
 * - A recording in progress names its final path
 * - New names are reserved, and a save's never collides
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	isReservedName,
	isSaveName,
	LEGACY_DIRECTORY,
	recordingFinal,
	recordingName,
	saveName,
} from './state.js';

/** The names `state.rs` reads too. */
const fixture = JSON.parse(
	readFileSync(
		join(
			import.meta.dir,
			'../../tauri-plugin-epicenter-folder/fixtures/reserved-names.json',
		),
		'utf8',
	),
) as {
	legacyDirectory: string;
	reserved: string[];
	notReserved: string[];
	recordings: { pending: string; final: string }[];
};

test('a staged save and a recording in progress are reserved; nothing else is', () => {
	expect(LEGACY_DIRECTORY).toBe(fixture.legacyDirectory);
	for (const path of fixture.reserved) expect(isReservedName(path)).toBe(true);
	for (const path of fixture.notReserved)
		expect(isReservedName(path)).toBe(false);
});

test('a recording in progress names its final path', () => {
	for (const { pending, final } of fixture.recordings) {
		expect(isReservedName(pending)).toBe(true);
		expect(isSaveName(pending)).toBe(false);
		expect(recordingFinal(pending)).toBe(final);
	}
	expect(recordingFinal('notes/a.md')).toBeNull();
});

test('new names are reserved, and saves do not collide', () => {
	const saves = new Set(Array.from({ length: 1000 }, saveName));
	expect(saves.size).toBe(1000);
	for (const name of saves) expect(isSaveName(name)).toBe(true);
	const take = recordingName('2026-11-06 take');
	expect(isReservedName(take)).toBe(true);
	expect(recordingFinal(`recordings/${take}`)).toBe(
		'recordings/2026-11-06 take.webm',
	);
});
