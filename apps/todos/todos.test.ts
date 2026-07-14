/**
 * Todos Workspace Tests
 *
 * Verifies todo domain behavior through the version 1 async SQLite workspace
 * and its application-owned action factory.
 *
 * Key behaviors:
 * - Contexts are a fixed set of built-in slugs carried by todo rows
 * - Unknown context slugs are rejected on the create path
 * - Due dates, completion, and soft deletion round-trip through async actions
 */

import { describe, expect, test } from 'bun:test';
import type { CalendarDateString } from '@epicenter/field';
import { openStandaloneWorkspace } from '@epicenter/workspace/sqlite/bun';
import { todosWorkspaceDefinition } from './src/versions/v1/definition.js';
import {
	BUILT_IN_CONTEXTS,
	type ContextSlug,
	createTodosActions,
} from './todos.js';

async function createTestTodos() {
	const workspace = await openStandaloneWorkspace(todosWorkspaceDefinition, {
		storage: { kind: 'memory' },
		onObserverError(error) {
			throw error;
		},
	});
	return {
		workspace,
		actions: createTodosActions(workspace),
		async [Symbol.asyncDispose]() {
			await workspace[Symbol.asyncDispose]();
		},
	};
}

describe('context slugs', () => {
	test('a todo carries built-in context slugs', async () => {
		await using todos = await createTestTodos();
		const id = await todos.actions.todos_create({
			title: 'Call back',
			contexts: ['phone', 'desk'],
		});

		expect((await todos.workspace.tables.todos.get(id))?.contexts).toEqual([
			'phone',
			'desk',
		]);
	});

	test('unknown context slugs are rejected', async () => {
		await using todos = await createTestTodos();
		await expect(
			todos.actions.todos_create({
				title: 'Nope',
				contexts: ['weekend'] as ContextSlug[],
			}),
		).rejects.toThrow('Unknown context');
	});

	test('repeated context slugs are deduplicated', async () => {
		await using todos = await createTestTodos();
		const id = await todos.actions.todos_create({
			title: 'Dup',
			contexts: ['phone', 'phone'],
		});

		expect((await todos.workspace.tables.todos.get(id))?.contexts).toEqual([
			'phone',
		]);
	});
});

describe('due dates', () => {
	test('a todo has no due date by default', async () => {
		await using todos = await createTestTodos();
		const id = await todos.actions.todos_create({ title: 'Someday' });
		expect((await todos.workspace.tables.todos.get(id))?.dueDate).toBeNull();
	});

	test('an all-day due date round-trips through create', async () => {
		await using todos = await createTestTodos();
		const id = await todos.actions.todos_create({
			title: 'Pay rent',
			dueDate: '2026-07-01' as CalendarDateString,
		});
		expect((await todos.workspace.tables.todos.get(id))?.dueDate).toBe(
			'2026-07-01',
		);
	});
});

describe('todo write path', () => {
	test('actions create, complete, and soft-delete one todo', async () => {
		await using todos = await createTestTodos();

		const id = await todos.actions.todos_create({
			title: 'Reply from mobile',
			contexts: ['phone'],
		});
		const created = await todos.workspace.tables.todos.get(id);
		expect(created?.title).toBe('Reply from mobile');
		expect(created?.contexts).toEqual(['phone']);
		expect(created?.completedAt).toBeNull();

		await todos.actions.todos_set_completed({ id, completed: true });
		expect(
			(await todos.workspace.tables.todos.get(id))?.completedAt,
		).not.toBeNull();

		await todos.actions.todos_delete({ id });
		expect(
			(await todos.workspace.tables.todos.get(id))?.deletedAt,
		).not.toBeNull();
	});

	test('list excludes soft-deleted rows', async () => {
		await using todos = await createTestTodos();

		const kept = await todos.actions.todos_create({ title: 'Keep' });
		const deleted = await todos.actions.todos_create({ title: 'Hide' });
		await todos.actions.todos_delete({ id: deleted });

		expect(await todos.actions.todos_list()).toEqual([
			expect.objectContaining({ id: kept, title: 'Keep' }),
		]);
	});
});

describe('built-in contexts', () => {
	test('the fixed code-defined contexts have distinct colors', () => {
		expect(BUILT_IN_CONTEXTS.map((context) => context.id)).toEqual([
			'phone',
			'computer',
			'desk',
		]);
		const colors = BUILT_IN_CONTEXTS.map((context) => context.color);
		expect(new Set(colors).size).toBe(colors.length);
	});
});
