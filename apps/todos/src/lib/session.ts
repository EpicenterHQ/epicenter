/**
 * What the store's parts share: the cache keys, the refusal error, and the
 * session each domain (`rows.ts`, `files.ts`, `git.ts`, `sync.ts`) is built
 * over. The store (`todos.svelte.ts`) creates the session once per opened
 * folder.
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
	files: ['todos', 'files'],
	status: ['todos', 'status'],
	text: (path: string) => ['todos', 'text', path] as const,
	/** Every write of a row or a file's text. */
	writes: ['todos', 'write'],
	write: (path: string) => ['todos', 'write', 'row', path] as const,
	writeText: (path: string) => ['todos', 'write', 'text', path] as const,
	move: (path: string) => ['todos', 'move', path] as const,
	remove: (path: string) => ['todos', 'remove', path] as const,
	recoverIncoming: ['todos', 'recover-incoming'],
});

/** Why an action did not start: Epicenter asks to leave, or a name or folder refuses it. */
export const TodosError = defineErrors({
	NotStarted: ({ reason }: { reason: string }) => ({ message: reason, reason }),
});
export type TodosError = InferErrors<typeof TodosError>;

/** Why input or a command was refused while Epicenter asks to quit or restart. */
export const DEPARTING =
	'Epicenter is asking to quit or restart, so nothing is changed now.';

/**
 * What the detail shows: a todo's fields (`todos`), a file's complete text
 * (`files`), or a todo whose text does not read as a todo, opened as text
 * from the list (`repair`).
 */
export type Selection = {
	readonly path: string;
	readonly as: 'todos' | 'files' | 'repair';
};

/** A write that failed and was rolled back to the file. */
export type WriteFailure = {
	readonly path: string;
	readonly error: TableError | FileError;
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
	/** Resolves once no write of a row or a file's text is running or waiting. */
	readonly writesSettled: () => Promise<void>;
	/** Read `queryKey` again, unless a write runs: then the last write reads. */
	readonly invalidate: (queryKey?: readonly unknown[]) => Promise<void>;
	/** Make the reading getter rerun when mutations start or settle. */
	readonly trackMutations: () => void;
	/** Resolves once nothing matching `filters` is mutating. */
	readonly whenIdle: (filters?: MutationFilters) => Promise<void>;
	/** Why no edit starts now, if one does not: Epicenter is asking to leave. */
	readonly refused: () => string | undefined;
	/** Whether a rename or delete of `path` runs or waits, which pauses its edits. */
	readonly moving: (path: string) => boolean;
	/** After a write settles: once it is the last one, everything is read again. */
	readonly afterWrite: () => Promise<void> | undefined;
	/** A write failed and was rolled back; the page tells the person. */
	readonly onWriteFailed: (failure: WriteFailure) => void;
	/** What the detail shows. Actions move it with the file they act on. */
	readonly selection: {
		readonly current: Selection | undefined;
		set(next: Selection | undefined): void;
	};
};
