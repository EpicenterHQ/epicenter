/**
 * Which apps the Folders window offers on a folder.
 *
 * Key behaviors:
 * - An app is offered on its own folder when the declaration contains its shape
 * - A declaration may declare more tables and fields than the shape
 * - A missing or mistyped field, or unreadable text, offers nothing
 * - Another folder of the same shape is not offered a built-in app yet
 * - An installed app that runs is offered on every folder its shape fits
 * - An installed app waiting for approval, or without a readable shape, is
 *   offered on no folder
 * - Every app not offered on a folder is listed under Apps
 */
import { describe, expect, test } from 'bun:test';
import { captureDefinition } from '@epicenter/capture/definition';
import {
	defineFolder,
	defineTable,
	field,
	formatDeclaration,
} from '@epicenter/folder';
import { todosDefinition } from '@epicenter/todos/definition';
import {
	type Application,
	CAPTURE_APPLICATION,
	TODOS_APPLICATION,
	WHISPERING_APPLICATION,
} from '../applications.ts';
import type { InstalledApp } from '../ui/bindings.gen';
import {
	appsWithoutFolder,
	FOLDER_OPENERS,
	installedOpeners,
	openersOf,
} from './openers.ts';

const TODOS = formatDeclaration(todosDefinition);

/** A Todos-shaped declaration, edited as `edit` says. */
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

describe('openersOf', () => {
	test('offers Todos on its own folder when the declaration is its shape', () => {
		expect(openersOf({ app: 'todos', declaration: TODOS })).toEqual([
			TODOS_APPLICATION,
		]);
		expect(
			openersOf({
				app: 'capture',
				declaration: formatDeclaration(captureDefinition),
			}),
		).toEqual([CAPTURE_APPLICATION]);
	});

	test('offers Todos on a folder that declares more than Todos reads', () => {
		const wider = todosWith((declared) => {
			declared.tables.todos!.properties.due = { type: 'string' };
			declared.tables.notes = { type: 'object', properties: {} };
		});
		expect(openersOf({ app: 'todos', declaration: wider })).toEqual([
			TODOS_APPLICATION,
		]);
	});

	test('offers nothing when a field Todos reads is missing or another type', () => {
		const missing = todosWith((declared) => {
			delete declared.tables.todos!.properties.done;
		});
		const mistyped = todosWith((declared) => {
			declared.tables.todos!.properties.done = { type: 'string' };
		});
		expect(openersOf({ app: 'todos', declaration: missing })).toEqual([]);
		expect(openersOf({ app: 'todos', declaration: mistyped })).toEqual([]);
	});

	test('offers nothing for text that is not a declaration', () => {
		for (const declaration of [null, '', 'not json', '{}', '[]']) {
			expect(openersOf({ app: 'todos', declaration })).toEqual([]);
		}
	});

	test('does not offer Todos on another folder of its shape', () => {
		// Launching Todos opens its own folder, not this one.
		expect(openersOf({ app: null, declaration: TODOS })).toEqual([]);
		expect(openersOf({ app: 'capture', declaration: TODOS })).toEqual([]);
	});
});

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

const BOARD: Application = {
	id: 'com.example.board',
	title: 'Board',
	installed: true,
};

describe('installed apps', () => {
	test('an installed app is offered on any folder whose declaration contains its shape', () => {
		const openers = [...FOLDER_OPENERS, ...installedOpeners([board()])];
		expect(openersOf({ app: 'todos', declaration: TODOS }, openers)).toEqual([
			TODOS_APPLICATION,
			BOARD,
		]);
		// Not Todos's own folder, and not named for any app.
		expect(openersOf({ app: null, declaration: TODOS }, openers)).toEqual([
			BOARD,
		]);
		const untitled = todosWith((declared) => {
			delete declared.tables.todos!.properties.title;
		});
		expect(openersOf({ app: null, declaration: untitled }, openers)).toEqual(
			[],
		);
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

describe('appsWithoutFolder', () => {
	test('lists every launchable app but the Folders window when no folder offers one', () => {
		expect(appsWithoutFolder([])).toEqual([
			CAPTURE_APPLICATION,
			TODOS_APPLICATION,
		]);
	});

	test('leaves out an app offered on a folder', () => {
		expect(appsWithoutFolder([TODOS_APPLICATION])).toEqual([
			CAPTURE_APPLICATION,
		]);
	});

	test('does not list Whispering, which Epicenter does not host yet', () => {
		expect(appsWithoutFolder([])).not.toContainEqual(WHISPERING_APPLICATION);
	});
});
