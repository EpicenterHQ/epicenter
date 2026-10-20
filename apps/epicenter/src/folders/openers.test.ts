/**
 * Which apps the Folders window offers on a folder.
 *
 * Key behaviors:
 * - Every bundled app is offered, with every installed app that can run, by
 *   title, whatever files the folder holds; each app supplies its own table
 *   schemas
 * - An installed copy of a bundled app is neither offered nor listed, so each
 *   bundled app appears once
 * - An app with an update waiting for approval is offered at its approved
 *   commit
 * - An installed app with no approved commit, or broken, is offered on no
 *   folder
 */
import { expect, test } from 'bun:test';
import type { InstalledApp } from '@epicenter/cli';
import {
	bundledOpeners,
	folderOpeners,
	listedInstalledApps,
	type Opener,
} from './openers.ts';

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

const BUNDLED: Opener[] = [
	{
		kind: 'bundled',
		app: 'capture',
		id: 'so.epicenter.capture',
		title: 'Capture',
	},
	{
		kind: 'bundled',
		app: 'honeycrisp',
		id: 'so.epicenter.honeycrisp',
		title: 'Honeycrisp',
	},
	{ kind: 'bundled', app: 'todos', id: 'so.epicenter.todos', title: 'Todos' },
	{
		kind: 'bundled',
		app: 'whispering',
		id: 'so.epicenter.whispering',
		title: 'Whispering',
	},
];

test('every bundled app is offered on a folder with no app installed', () => {
	expect(bundledOpeners).toEqual(BUNDLED);
	expect(folderOpeners([])).toEqual(BUNDLED);
});

test('every installed app that can run is offered beside the bundled apps, by title', () => {
	expect(
		folderOpeners([
			app({ id: 'com.example.notes', title: 'Notes' }),
			app({ state: { kind: 'unbuilt' } }),
		]).map((opener) => opener.id),
	).toEqual([
		'com.example.board',
		'so.epicenter.capture',
		'so.epicenter.honeycrisp',
		'com.example.notes',
		'so.epicenter.todos',
		'so.epicenter.whispering',
	]);
	expect(folderOpeners([app()])[0]).toEqual({
		kind: 'installed',
		id: 'com.example.board',
		title: 'Board',
		commit: 'a'.repeat(40),
	});
});

test('an installed copy of a bundled app is neither offered nor listed', () => {
	const copies = ['todos', 'capture', 'honeycrisp', 'whispering'].map((name) =>
		app({ id: `so.epicenter.${name}`, title: name }),
	);
	const board = app();
	expect(listedInstalledApps([...copies, board])).toEqual([board]);
	expect(folderOpeners(copies)).toEqual(BUNDLED);
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
		folderOpeners([app({ pending: { ...review, from: 'a'.repeat(40) } })]).find(
			(opener) => opener.kind === 'installed',
		),
	).toEqual({
		kind: 'installed',
		id: 'com.example.board',
		title: 'Board',
		commit: 'a'.repeat(40),
	});
});

test('an app with no approved commit, or broken, is not offered', () => {
	expect(
		folderOpeners([
			app({ commit: '', state: { kind: 'needsApproval' }, pending: review }),
			app({ commit: '', state: { kind: 'broken', problem: 'no manifest' } }),
		]),
	).toEqual(BUNDLED);
});
