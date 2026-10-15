/**
 * `folderOptions` mirrors the folder's own types: each table's rows, its
 * settings, and the errors each operation can return.
 */
import { expectTypeOf } from 'bun:test';
import type {
	MutationObserverOptions,
	QueryObserverOptions,
} from '@tanstack/query-core';
import {
	type ContentCapture,
	defineFolder,
	defineTable,
	type FileCapture,
	type Folder,
	field,
	type Row,
	type RowReadError,
	type SavedRow,
	type StoredRow,
	type TableListing,
	type TableSaveError,
} from './contract.js';
import { createDraft, folderOptions } from './query.js';

const definition = defineFolder({
	kv: { theme: field.string() },
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
		files: defineTable({ fields: { name: field.string() } }),
	},
});
type Todo = { title: string; done: boolean };
declare const folder: Folder<typeof definition>;
const folder$ = folderOptions(folder);

type QueryData<T> =
	T extends QueryObserverOptions<infer TData, infer _TError> ? TData : never;
type QueryError<T> =
	T extends QueryObserverOptions<infer _TData, infer TError> ? TError : never;
type Variables<T> =
	T extends MutationObserverOptions<
		infer _TData,
		infer _TError,
		infer TVariables
	>
		? TVariables
		: never;
type MutationData<T extends { mutationFn?: unknown }> = Awaited<
	ReturnType<Extract<T['mutationFn'], (...args: never[]) => unknown>>
>;
type MutationError<T extends { onError?: unknown }> = Parameters<
	Extract<T['onError'], (...args: never[]) => unknown>
>[0];

// Each read's options carry its data and error types.
type List = ReturnType<typeof folder$.todos.list.queryOptions>;
expectTypeOf<QueryData<List>>().toEqualTypeOf<TableListing<Todo>>();
type Get = ReturnType<typeof folder$.todos.get.queryOptions>;
expectTypeOf<QueryData<Get>>().toEqualTypeOf<StoredRow<Todo> | null>();
expectTypeOf<QueryError<Get>>().toEqualTypeOf<RowReadError>();
type Settings = ReturnType<typeof folder$.kv.get.queryOptions>;
expectTypeOf<QueryData<Settings>>().toEqualTypeOf<NonNullable<
	Awaited<ReturnType<typeof folder.kv.get>>['data']
> | null>();

// A save sends the base it started from, with its content, and the edited row.
type Save = ReturnType<typeof folder$.todos.save.mutationOptions>;
expectTypeOf<Variables<Save>>().toEqualTypeOf<{
	readonly base: ContentCapture;
	readonly row: Row<Todo>;
}>();
expectTypeOf<MutationData<Save>>().toEqualTypeOf<SavedRow<Todo>>();
expectTypeOf<MutationError<Save>>().toEqualTypeOf<TableSaveError>();
// A table's rows are its own.
type Create = Variables<
	ReturnType<typeof folder$.todos.create.mutationOptions>
>;
expectTypeOf<{
	row: { fields: { name: string }; body: string };
}>().not.toMatchTypeOf<Create>();

// A setting's value is its own key's.
type Set = Variables<ReturnType<typeof folder$.kv.set.mutationOptions>>;
expectTypeOf<{ key: 'theme'; value: 'dark' }>().toMatchTypeOf<Set>();
expectTypeOf<{ key: 'theme'; value: 1 }>().not.toMatchTypeOf<Set>();

// A table named like a member is under `tables`; the member keeps its name.
expectTypeOf(folder$.tables.files.list.queryOptions).toBeFunction();
expectTypeOf(folder$.files.read.queryKey).toEqualTypeOf<
	(path: string) => readonly unknown[]
>();

// A draft saves through the same variables.
const draft = createDraft<Todo>();
expectTypeOf<NonNullable<ReturnType<typeof draft.toSave>>>().toMatchTypeOf<
	Variables<Save>
>();
expectTypeOf(draft.changedElsewhere)
	.parameter(0)
	.toEqualTypeOf<FileCapture | undefined>();
