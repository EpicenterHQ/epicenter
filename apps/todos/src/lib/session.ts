/**
 * What the store's parts share: the app's own mutation keys, the refusal
 * error and its message, the write-failure type, and the session each domain
 * (`rows.ts`, `git.ts`, `sync.ts`) is built over. The store
 * (`todos.svelte.ts`) creates the session once per opened folder. Every
 * query is keyed under the folder's options (`folder$`), so a change the
 * folder reports marks exactly what it names stale.
 */
import type { FileError, TableError } from '@epicenter/folder';
import type { FolderOptions } from '@epicenter/folder/query';
import type { MutationFilters, QueryClient } from '@tanstack/query-core';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { type createQueryFactories, defineKeys } from 'wellcrafted/query';
import type { todosDefinition } from './definition.js';
import type { TodosFolder } from './platform/types.js';

/** Cache identity for the mutations the app runs beyond the folder's own. */
export const todosKeys = defineKeys({
	/** The delete of the file at `path`, which pauses its edits. */
	remove: (path: string) => ['todos', 'remove', path] as const,
});

/** Why an action did not start: what it would change is not what the person saw. */
export const TodosError = defineErrors({
	NotStarted: ({ reason }: { reason: string }) => ({ message: reason, reason }),
});
export type TodosError = InferErrors<typeof TodosError>;

/** A save that failed. The editor keeps the edit; `unsaved` is it as text. */
export type WriteFailure = {
	readonly path: string;
	readonly error: TableError | FileError | TodosError;
	/** The text that was in the editor and is not in the file. */
	readonly unsaved: string;
};

/** One opened folder's cache and the rules every domain follows over it. */
export type Session = {
	readonly folder: TodosFolder;
	/** The folder's query and mutation options; every query is keyed under them. */
	readonly folder$: FolderOptions<typeof todosDefinition>;
	readonly queryClient: QueryClient;
	readonly defineQuery: ReturnType<typeof createQueryFactories>['defineQuery'];
	readonly defineMutation: ReturnType<
		typeof createQueryFactories
	>['defineMutation'];
	/** Resolves once no save of a todo's file is running. */
	readonly writesSettled: () => Promise<void>;
	/** Read `queryKey` again; every query of the folder by default. */
	readonly invalidate: (queryKey?: readonly unknown[]) => Promise<void>;
	/** Resolves once nothing matching `filters` is mutating, including what starts meanwhile. */
	readonly whenIdle: (filters?: MutationFilters) => Promise<void>;
	/** A save failed; the page tells the person. */
	readonly onWriteFailed: (failure: WriteFailure) => void;
};
