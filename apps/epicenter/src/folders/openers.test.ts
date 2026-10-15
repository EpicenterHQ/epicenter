/**
 * Which installed apps the Folders window offers on a folder.
 *
 * Key behaviors:
 * - An installed app that runs is offered on every folder whose declaration
 *   contains its shape
 * - A declaration may declare more tables and fields than the shape
 * - A missing or mistyped field, or unreadable text, offers nothing
 * - An installed app waiting for approval, or without a readable shape, is
 *   offered on no folder
 */
import { describe, expect, test } from 'bun:test';
import {
	defineFolder,
	defineTable,
	field,
	formatDeclaration,
} from '@epicenter/folder';
import type { Application } from '../applications.ts';
import type { InstalledApp } from '../ui/bindings.gen';
import { installedOpeners, openersOf } from './openers.ts';

/** A declaration with a `todos` table of `title` and `done`. */
const TODOS = formatDeclaration(
	defineFolder({
		title: 'Todos',
		kv: {},
		tables: {
			todos: defineTable({
				fields: { title: field.string(), done: field.boolean() },
			}),
		},
	}),
);

/** `TODOS`, edited as `edit` says. */
function todosWith(edit: (declared: TodosDeclaration) => void): string {
	const declared = JSON.parse(TODOS) as TodosDeclaration;
	edit(declared);
	return JSON.stringify(declared);
}
type TodosDeclaration = {
	tables: Record<
		string,
		{ type: 'object'; properties: Record<string, unknown>; required?: string[] }
	>;
};

/** An installed app that reads `title` from a `todos` table. */
function board(overrides: Partial<InstalledApp> = {}): InstalledApp {
	return {
		id: 'com.example.board',
		title: 'Board',
		source: 'https://example.com/board.git',
		folder: '',
		commit: 'a'.repeat(40),
		opens: formatDeclaration(
			defineFolder({
				kv: {},
				tables: {
					todos: defineTable({ fields: { title: field.string() } }),
				},
			}),
		),
		state: { kind: 'ready' },
		...overrides,
	};
}

const BOARD: Application = { id: 'com.example.board', title: 'Board' };
const OPENERS = installedOpeners([board()]);

describe('installed apps', () => {
	test('an installed app is offered on any folder whose declaration contains its shape', () => {
		expect(openersOf({ declaration: TODOS }, OPENERS)).toEqual([BOARD]);
	});

	test('it is offered on a folder that declares more than it reads', () => {
		const wider = todosWith((declared) => {
			declared.tables.todos!.properties.due = { type: 'string' };
			declared.tables.notes = { type: 'object', properties: {} };
		});
		expect(openersOf({ declaration: wider }, OPENERS)).toEqual([BOARD]);
	});

	test('nothing is offered when a field it reads is missing or another type', () => {
		const missing = todosWith((declared) => {
			delete declared.tables.todos!.properties.title;
		});
		const mistyped = todosWith((declared) => {
			declared.tables.todos!.properties.title = { type: 'boolean' };
		});
		expect(openersOf({ declaration: missing }, OPENERS)).toEqual([]);
		expect(openersOf({ declaration: mistyped }, OPENERS)).toEqual([]);
	});

	test('nothing is offered for text that is not a declaration', () => {
		for (const declaration of [null, '', 'not json', '{}', '[]']) {
			expect(openersOf({ declaration }, OPENERS)).toEqual([]);
		}
	});

	test('an app built only when opened is offered; one waiting for approval is not', () => {
		const review = {
			from: null,
			log: '',
			diffStat: '',
			statement: 'Building runs code.',
		};
		expect(
			installedOpeners([board({ state: { kind: 'unbuilt' } })]).map(
				({ application }) => application,
			),
		).toEqual([BOARD]);
		for (const state of [
			{ kind: 'needsApproval', review },
			{ kind: 'broken', problem: 'no manifest' },
		] as const) {
			expect(installedOpeners([board({ state })])).toEqual([]);
		}
	});

	test('an app whose shape cannot be read opens no folder', () => {
		for (const opens of [null, 'not json', '[]']) {
			expect(installedOpeners([board({ opens })])).toEqual([]);
		}
	});
});
