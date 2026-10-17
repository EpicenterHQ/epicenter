/**
 * `folderOptions` and `folderWrites` mirror the folder's own types: each
 * table's rows and the errors each operation can return.
 */
import { expectTypeOf } from 'bun:test';
import type { QueryClient, QueryObserverOptions } from '@tanstack/query-core';
import type { Result } from 'wellcrafted/result';
import {
	defineFolder,
	defineTable,
	type FileContent,
	type FileError,
	type Folder,
	field,
	type Row,
	type RowWriteError,
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
declare const client: QueryClient;
const folder$ = folderOptions(folder);
const writes = folderWrites(folder, client);

type QueryData<T> =
	T extends QueryObserverOptions<infer TData, infer _TError> ? TData : never;
type QueryError<T> =
	T extends QueryObserverOptions<infer _TData, infer TError> ? TError : never;

// Each read's options carry its data and error types.
type List = ReturnType<typeof folder$.todos.list.queryOptions>;
expectTypeOf<QueryData<List>>().toEqualTypeOf<TableListing<Todo>>();
expectTypeOf<QueryError<List>>().toEqualTypeOf<FileError>();

// A row write sends the change from one row to another, either one absent.
expectTypeOf(writes.tables.todos.write).parameters.toEqualTypeOf<
	[stem: string, from: Row<Todo> | null, to: Row<Todo> | null]
>();
expectTypeOf(writes.tables.todos.write).returns.toEqualTypeOf<
	Promise<Result<WrittenRow<Todo>, RowWriteError>>
>();
// A delete sends the stem it deletes.
expectTypeOf(writes.tables.todos.delete).returns.toEqualTypeOf<
	Promise<Result<undefined, WriteError>>
>();
// A table's rows are its own.
expectTypeOf<{
	fields: { name: string };
	body: string;
}>().not.toMatchTypeOf<Parameters<typeof writes.tables.todos.create>[0]>();

// The folder's write and move mirror the handle's, for any path.
expectTypeOf(writes.write).parameters.toEqualTypeOf<
	[path: string, from: FileContent | null, to: FileContent | null]
>();
expectTypeOf(writes.write).returns.toEqualTypeOf<
	Promise<Result<Written, WriteError>>
>();
expectTypeOf(writes.move).returns.toEqualTypeOf<
	Promise<Result<Written, WriteError>>
>();

// A table named like a member is under `tables`; the member keeps its name.
// No member is named for settings, which are a table: `kv` is a table's name.
expectTypeOf(folder$.tables.files.list.queryOptions).toBeFunction();
expectTypeOf(folder$.kv.list.queryOptions).toBeFunction();
expectTypeOf(folder$.files.read.queryKey).toEqualTypeOf<
	(path: string) => readonly unknown[]
>();

// A set of one row sends the fields it sets, as the row holds them now.
expectTypeOf<[stem: 'milk', fields: { done: true }]>().toExtend<
	Parameters<typeof writes.tables.todos.set>
>();
expectTypeOf<[stem: 'milk', fields: { done: 'yes' }]>().not.toExtend<
	Parameters<typeof writes.tables.todos.set>
>();

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
