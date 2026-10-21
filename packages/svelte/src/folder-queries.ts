/**
 * Query identity and readers for one opened folder. No query options are
 * retained here.
 *
 * Queries list and derive; they own no editable document. The folder's edit
 * of a row or file owns that (`@epicenter/svelte/edits`), and a row list or
 * file read through these queries keeps it current.
 */
import type { Folder, FolderFiles, ReadError, Row } from '@epicenter/folder';
import { readDocuments } from '@epicenter/folder/documents';
import type { DataTag, QueryFunctionContext } from '@tanstack/query-core';
import type { TSchema } from 'typebox';
import { defineKeys } from 'wellcrafted/query';
import type { Result } from 'wellcrafted/result';

export const folderKeys = defineKeys({
	all: ['folder'],
	files: ['folder', 'files'],
	documents: ['folder', 'documents'],
	rows: (table: string) => ['folder', 'rows', table] as const,
	file: (path: string, representation: string) =>
		['folder', 'file', path, representation] as const,
	read: (path: string) => ['folder', 'read', path] as const,
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
	/** TanStack Query's own default unless the representation says otherwise. */
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
				queryFn: async () => {
					const read = await readDocuments(folder.files);
					if (read.error !== null) throw read.error;
					return read.data;
				},
			};
		},
		/**
		 * The file of `edit` read again while a view observes this query, on
		 * the context's visible polling: the way an edit shown with no list
		 * over its file learns of outside edits nothing reports. The edit owns
		 * the document and its read status; a change the folder reports is
		 * read by the edit itself, not through this query.
		 */
		read(edit: {
			readonly path: string;
			read(): Promise<Result<unknown, ReadError>>;
		}) {
			return {
				queryKey: folderKeys.read(edit.path),
				queryFn: async () => {
					const { error } = await edit.read();
					if (error !== null) throw error;
					return null;
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
				structuralSharing: reader.structuralSharing,
			};
		},
	};
}
