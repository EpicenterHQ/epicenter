/**
 * Which apps the Folders window offers on a folder.
 *
 * Key behaviors:
 * - An app is offered on its own folder when the declaration contains its shape
 * - A declaration may declare more tables and fields than the shape
 * - A missing or mistyped field, or unreadable text, offers nothing
 * - Another folder of the same shape is not offered the app yet
 * - Every app not offered on a folder is listed under Apps
 */
import { describe, expect, test } from 'bun:test';
import { captureDefinition } from '@epicenter/capture/definition';
import { formatDeclaration } from '@epicenter/folder';
import { todosDefinition } from '@epicenter/todos/definition';
import {
	CAPTURE_APPLICATION,
	TODOS_APPLICATION,
	WHISPERING_APPLICATION,
} from '../applications.ts';
import { appsWithoutFolder, openersOf } from './openers.ts';

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

describe('appsWithoutFolder', () => {
	test('lists every compiled app but the Folders window when no folder offers one', () => {
		expect(appsWithoutFolder([])).toEqual([
			WHISPERING_APPLICATION,
			CAPTURE_APPLICATION,
			TODOS_APPLICATION,
		]);
	});

	test('leaves out an app offered on a folder', () => {
		expect(appsWithoutFolder([TODOS_APPLICATION])).toEqual([
			WHISPERING_APPLICATION,
			CAPTURE_APPLICATION,
		]);
	});
});
