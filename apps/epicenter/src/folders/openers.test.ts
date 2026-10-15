/**
 * Which installed apps the Folders window offers on a folder.
 *
 * Key behaviors:
 * - Every installed app that can run is offered, by title, whatever the
 *   folder declares; the app's own lens refuses a folder that does not fit
 * - An installed app waiting for approval, or broken, is offered on no folder
 */
import { expect, test } from 'bun:test';
import type { InstalledApp } from '../ui/bindings.gen';
import { installedOpeners } from './openers.ts';

function app(overrides: Partial<InstalledApp> = {}): InstalledApp {
	return {
		id: 'com.example.board',
		title: 'Board',
		source: 'https://example.com/board.git',
		folder: '',
		commit: 'a'.repeat(40),
		state: { kind: 'ready' },
		...overrides,
	};
}

test('every app that can run is offered, by title', () => {
	expect(
		installedOpeners([
			app({ id: 'com.example.notes', title: 'Notes' }),
			app({ state: { kind: 'unbuilt' } }),
		]),
	).toEqual([
		{ id: 'com.example.board', title: 'Board' },
		{ id: 'com.example.notes', title: 'Notes' },
	]);
});

test('an app waiting for approval, or broken, is not offered', () => {
	const review = {
		from: null,
		log: '',
		diffStat: '',
		statement: 'Building runs code.',
	};
	for (const state of [
		{ kind: 'needsApproval', review },
		{ kind: 'broken', problem: 'no manifest' },
	] as const) {
		expect(installedOpeners([app({ state })])).toEqual([]);
	}
});
