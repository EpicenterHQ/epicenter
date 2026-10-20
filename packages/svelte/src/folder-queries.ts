/**
 * Query identity and readers for one opened folder. No query options are
 * retained here.
 *
 * Rows, documents and file reads carry the read that answered them, the
 * source an edit names (`@epicenter/folder`'s read notes). A newer read must
 * reach a view as its own values, so these queries turn structural sharing
 * off, which also applies to an observer's `select`: a cache that kept an
 * older equal value would show the view an older read than it was given.
 */
import type { Folder, FolderFiles, Row } from '@epicenter/folder';
import { readDocuments } from '@epicenter/folder/documents';
import type { DataTag, QueryFunctionContext } from '@tanstack/query-core';
import type { TSchema } from 'typebox';
import { defineKeys } from 'wellcrafted/query';

export const folderKeys = defineKeys({
	all: ['folder'],
	files: ['folder', 'files'],
	documents: ['folder', 'documents'],
	rows: (table: string) => ['folder', 'rows', table] as const,
	file: (path: string, representation: string) =>
		['folder', 'file', path, representation] as const,
});

/** One decoded file value and the policy every observer of it shares. */
export type FileReader<TData> = {
	name: string;
	read: (
		files: FolderFiles,
		path: string,
		query: QueryFunctionContext,
	) => Promise<TData>;
	gcTime?: number;
	/** Off unless the value carries no source an edit names. */
	structuralSharing?: boolean;
};

/** Define a file representation once, including its decoding and cache policy. */
export function defineFileRead<TData>(
	name: string,
	read: (
		files: FolderFiles,
		path: string,
		query: QueryFunctionContext,
	) => Promise<TData>,
	options: { gcTime?: number; structuralSharing?: boolean } = {},
) {
	return { name, read, ...options };
}

/** Keys identify cached values: different file representations never share one entry. */
export function createFolderQueries<TTables extends Record<string, TSchema>>(
	folder: Folder<TTables>,
) {
	return {
		key: folderKeys.all,
		/** Every row in the table, including its source and any validation issues. */
		rows<TName extends keyof TTables & string>(table: TName) {
			return {
				queryKey: folderKeys.rows(table),
				structuralSharing: false,
				queryFn: async (): Promise<Row<TTables[TName]>[]> => {
					const listed = await folder.tables[table].list();
					if (listed.error !== null) throw listed.error;
					return listed.data;
				},
			};
		},
		/** Every file path, relative to the folder and sorted. */
		files() {
			return {
				queryKey: folderKeys.files,
				queryFn: async () => {
					const listed = await folder.files.list();
					if (listed.error !== null) throw listed.error;
					return listed.data;
				},
			};
		},
		/** Markdown interpreted with the folder's optional declarations. */
		documents() {
			return {
				queryKey: folderKeys.documents,
				structuralSharing: false,
				queryFn: async () => {
					const read = await readDocuments(folder.files);
					if (read.error !== null) throw read.error;
					return read.data;
				},
			};
		},
		/** An app's decoded value, keyed by the path and its representation. */
		file<TData>(path: string, reader: FileReader<TData>) {
			return {
				queryKey: folderKeys.file(path, reader.name) as DataTag<
					ReturnType<typeof folderKeys.file>,
					TData
				>,
				queryFn: (query: QueryFunctionContext) =>
					reader.read(folder.files, path, query),
				gcTime: reader.gcTime,
				structuralSharing: reader.structuralSharing ?? false,
			};
		},
	};
}
