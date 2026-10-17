/**
 * `folderOptions` mirrors the folder's own types: each table's rows and the
 * errors each operation can return.
 */
import { expectTypeOf } from 'bun:test';
import type {
	MutationObserverOptions,
	QueryClient,
	QueryObserverOptions,
} from '@tanstack/query-core';
import type { Result } from 'wellcrafted/result';
import {
	defineFolder,
	defineTable,
	type FileContent,
	type Folder,
	field,
	type Row,
	type RowReadError,
	type RowWriteError,
	type StoredRow,
	type TableListing,
	type WriteError,
	type Written,
	type WrittenRow,
} from './contract.js';
import { folderOptions, folderWrites } from './query.js';

const definition = defineFolder({
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
		files: defineTable({ fields: { name: field.string() } }),
		kv: defineTable({ fields: { note: field.string() } }),
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

// A row write sends the change from one row to another, either one absent.
type Write = ReturnType<typeof folder$.todos.write.mutationOptions>;
expectTypeOf<Variables<Write>>().toEqualTypeOf<{
	readonly stem: string;
	readonly from: Row<Todo> | null;
	readonly to: Row<Todo> | null;
}>();
expectTypeOf<MutationData<Write>>().toEqualTypeOf<WrittenRow<Todo>>();
expectTypeOf<MutationError<Write>>().toEqualTypeOf<RowWriteError>();
// A delete sends the stem it deletes.
type Delete = ReturnType<typeof folder$.todos.delete.mutationOptions>;
expectTypeOf<Variables<Delete>>().toEqualTypeOf<string>();
expectTypeOf<MutationError<Delete>>().toEqualTypeOf<WriteError>();
// A table's rows are its own.
type Create = Variables<
	ReturnType<typeof folder$.todos.create.mutationOptions>
>;
expectTypeOf<{
	row: { fields: { name: string }; body: string };
}>().not.toMatchTypeOf<Create>();

// The folder's write and move mirror the handle's, for any path.
type WriteFile = ReturnType<typeof folder$.write.mutationOptions>;
expectTypeOf<Variables<WriteFile>>().toEqualTypeOf<{
	readonly path: string;
	readonly from: FileContent | null;
	readonly to: FileContent | null;
}>();
expectTypeOf<MutationData<WriteFile>>().toEqualTypeOf<Written>();
expectTypeOf<MutationError<WriteFile>>().toEqualTypeOf<WriteError>();
type MoveFile = ReturnType<typeof folder$.move.mutationOptions>;
expectTypeOf<Variables<MoveFile>>().toEqualTypeOf<{
	readonly path: string;
	readonly next: string;
}>();
expectTypeOf<MutationError<MoveFile>>().toEqualTypeOf<WriteError>();

// A table named like a member is under `tables`; the member keeps its name.
// No member is named for settings, which are a table: `kv` is a table's name.
expectTypeOf(folder$.tables.files.list.queryOptions).toBeFunction();
expectTypeOf(folder$.kv.list.queryOptions).toBeFunction();
expectTypeOf(folder$.files.read.queryKey).toEqualTypeOf<
	(path: string) => readonly unknown[]
>();

// A set of one row sends the fields it sets, as the row holds them now.
type SetRow = ReturnType<typeof folder$.todos.set.mutationOptions>;
expectTypeOf<{ stem: 'milk'; fields: { done: true } }>().toExtend<
	Variables<SetRow>
>();
expectTypeOf<{ stem: 'milk'; fields: { done: 'yes' } }>().not.toExtend<
	Variables<SetRow>
>();
expectTypeOf<MutationData<SetRow>>().toEqualTypeOf<WrittenRow<Todo>>();
expectTypeOf<MutationError<SetRow>>().toEqualTypeOf<RowWriteError>();

// The definition is inferred from the folder.
const plain = defineFolder({
	title: 'Plain',
	tables: {
		todos: defineTable({ fields: { title: field.string() } }),
	},
});
declare const plainFolder: Folder<typeof plain>;
const plain$ = folderOptions(plainFolder);
expectTypeOf<
	QueryData<ReturnType<typeof plain$.todos.list.queryOptions>>
>().toEqualTypeOf<TableListing<{ title: string }>>();

// `folderWrites` answers each write's Result, typed by the folder's tables.
declare const client: QueryClient;
const writes = folderWrites(folder, client);
expectTypeOf(writes.tables.todos.write).parameters.toEqualTypeOf<
	[stem: string, from: Row<Todo> | null, to: Row<Todo> | null]
>();
expectTypeOf(writes.tables.todos.write).returns.toEqualTypeOf<
	Promise<Result<WrittenRow<Todo>, RowWriteError>>
>();
expectTypeOf(writes.tables.todos.delete).returns.toEqualTypeOf<
	Promise<Result<undefined, WriteError>>
>();
expectTypeOf(writes.write).returns.toEqualTypeOf<
	Promise<Result<Written, WriteError>>
>();
expectTypeOf<[stem: 'milk', fields: { done: 'yes' }]>().not.toExtend<
	Parameters<typeof writes.tables.todos.set>
>();
