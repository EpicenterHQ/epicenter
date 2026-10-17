/**
 * Which installed apps the Folders window offers on a folder.
 *
 * Key behaviors:
 * - Every installed app that can run is offered, by title, whatever the
 *   folder declares; the app refuses a folder whose declaration does not
 *   contain its definition
 * - An app with an update waiting for approval is offered at its approved
 *   commit
 * - An installed app with no approved commit, or broken, is offered on no
 *   folder
 */
import { expect, test } from 'bun:test';
import type { InstalledApp } from '@epicenter/cli';
import { installedOpeners } from './openers.ts';

function app(overrides: Partial<InstalledApp> = {}): InstalledApp {
	return {
		id: 'com.example.board',
		title: 'Board',
		source: 'https://example.com/board.git',
		folder: '',
		commit: 'a'.repeat(40),
		state: { kind: 'ready' },
		pending: null,
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
		{ id: 'com.example.board', title: 'Board', commit: 'a'.repeat(40) },
		{ id: 'com.example.notes', title: 'Notes', commit: 'a'.repeat(40) },
	]);
});

const review = {
	commit: 'b'.repeat(40),
	from: null,
	log: '',
	diffStat: '',
	statement: 'Building runs code.',
};

test('an app with an update waiting for approval opens at its approved commit', () => {
	expect(
		installedOpeners([app({ pending: { ...review, from: 'a'.repeat(40) } })]),
	).toEqual([
		{ id: 'com.example.board', title: 'Board', commit: 'a'.repeat(40) },
	]);
});

test('an app with no approved commit, or broken, is not offered', () => {
	expect(
		installedOpeners([
			app({ commit: '', state: { kind: 'needsApproval' }, pending: review }),
			app({ commit: '', state: { kind: 'broken', problem: 'no manifest' } }),
		]),
	).toEqual([]);
});
