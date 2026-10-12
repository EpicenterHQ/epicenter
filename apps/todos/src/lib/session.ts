/**
 * What the store's parts share: the cache keys, the refusal error and its
 * message, the write-failure type, and the session each domain (`rows.ts`,
 * `git.ts`, `sync.ts`) is built over. The store (`todos.svelte.ts`) creates
 * the session once per opened folder.
 */
import type { FileError, TableError } from '@epicenter/folder';
import type { MutationFilters, QueryClient } from '@tanstack/query-core';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { type createQueryFactories, defineKeys } from 'wellcrafted/query';
import type { TodosFolder } from './platform/types.js';

/** Cache identity for every query and mutation the app runs. */
export const todosKeys = defineKeys({
	/** Every query the app keeps; read again after the app's own actions. */
	all: ['todos'],
	rows: ['todos', 'rows'],
	status: ['todos', 'status'],
	/** Every write of a todo's file: a row's fields, or a repair's text. */
	writes: ['todos', 'write'],
	write: (path: string) => ['todos', 'write', 'row', path] as const,
	repair: (path: string) => ['todos', 'write', 'repair', path] as const,
	move: (path: string) => ['todos', 'move', path] as const,
	remove: (path: string) => ['todos', 'remove', path] as const,
	recoverIncoming: ['todos', 'recover-incoming'],
});

/** Why an action did not start: Epicenter asks to leave, or a name refuses it. */
export const TodosError = defineErrors({
	NotStarted: ({ reason }: { reason: string }) => ({ message: reason, reason }),
});
export type TodosError = InferErrors<typeof TodosError>;

/** Why input or a command was refused while Epicenter asks to quit or restart. */
export const DEPARTING =
	'Epicenter is asking to quit or restart, so nothing is changed now.';

/** A write that failed: a row's was rolled back to the file; a repair's text was not written. */
export type WriteFailure = {
	readonly path: string;
	readonly error: TableError | FileError | TodosError;
	/** The text that was in the editor and is not in the file. */
	readonly lost: string;
};

/** One opened folder's cache and the rules every domain follows over it. */
export type Session = {
	readonly folder: TodosFolder;
	readonly queryClient: QueryClient;
	readonly defineQuery: ReturnType<typeof createQueryFactories>['defineQuery'];
	readonly defineMutation: ReturnType<
		typeof createQueryFactories
	>['defineMutation'];
	/** Resolves once no write of a todo's file is running or waiting. */
	readonly writesSettled: () => Promise<void>;
	/** Read `queryKey` again. */
	readonly invalidate: (queryKey?: readonly unknown[]) => Promise<void>;
	/** Make the reading getter rerun when mutations start or settle. */
	readonly trackMutations: () => void;
	/** Resolves once nothing matching `filters` is mutating, including what starts meanwhile. */
	readonly whenIdle: (filters?: MutationFilters) => Promise<void>;
	/** Why no edit starts now, if one does not: Epicenter is asking to leave. */
	readonly refused: () => string | undefined;
	/** After a write settles: once it is the last one, everything is read again. */
	readonly afterWrite: () => Promise<void> | undefined;
	/** A write failed; the page tells the person. */
	readonly onWriteFailed: (failure: WriteFailure) => void;
};
