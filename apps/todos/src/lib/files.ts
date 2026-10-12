/**
 * `todos.files`: every file in the folder, as the file browser shows it and
 * as text, and the actions on files: create, rename, delete. A file's text is
 * edited the way a todo is (`rows.ts`): in the cache, then written in the
 * file's queue.
 */
import {
	type FileCapture,
	type FileError,
	type FileListing,
	type FolderFiles,
	type MoveError,
	pathProblem,
	type TableError,
} from '@epicenter/folder';
import {
	basename,
	dirname,
	joinPath,
	type OpenedFile,
	readTextFile as readFolderTextFile,
} from '@epicenter/folder/file-browser';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { createGit } from './git.js';
import { type Session, TodosError, todosKeys } from './session.js';
import { type TodoListing, todoStem } from './todo-listing.js';

/** Why `name` cannot name a file in `directory`, in words a person acts on. */
export function nameProblem(
	directory: string,
	name: string,
): string | undefined {
	if (name === '') return 'Enter a name.';
	if (name.includes('/')) return 'A name cannot contain "/".';
	const problem = pathProblem(joinPath(directory, name));
	return problem === undefined
		? undefined
		: `This name is not usable: ${problem}.`;
}

/** Text larger than this opens as file details instead of in the editor. */
export const EDITABLE_TEXT_LIMIT = 1024 * 1024;

/** Read editable text using this app's size limit. */
export function readTextFile(files: Pick<FolderFiles, 'read'>, path: string) {
	return readFolderTextFile(files, path, EDITABLE_TEXT_LIMIT);
}

/** What a confirmed deletion removes, as the person was asked about it. */
export type Deletion =
	| { readonly kind: 'folder'; readonly path: string }
	| {
			readonly kind: 'todo' | 'file';
			readonly path: string;
			/** What the dialog names: a todo's title, or the file's name. */
			readonly title: string;
			/** The file as it was when the person was asked, for a file no view holds. */
			readonly capture: FileCapture;
			/**
			 * Whether the file has changes that are in no saved version, as Git
			 * status last checked; `undefined` when the check failed.
			 */
			readonly unversioned: boolean | undefined;
	  };

export function createFiles(
	{
		folder,
		queryClient,
		defineQuery,
		defineMutation,
		invalidate,
		trackMutations,
		refused,
		moving,
		afterWrite,
		onWriteFailed,
		selection,
	}: Session,
	/** Git status tells deletion whether a file has changes in no saved version. */
	{ status }: Pick<ReturnType<typeof createGit>, 'status'>,
) {
	const table = folder.tables.todos;
	/** Files whose cached text holds an edit no write has sent; see `rows.ts`. */
	const unsent = new Set<string>();
	const rowsData = () => queryClient.getQueryData<TodoListing>(todosKeys.rows);
	const textData = (path: string) =>
		queryClient.getQueryData<OpenedFile>(todosKeys.text(path));

	/** Change the text of `path` in the cache, if it holds text. */
	function mapText(
		path: string,
		change: (file: { path: string; sha256: string; text: string }) => {
			path: string;
			sha256: string;
			text: string;
		},
	): boolean {
		let changed = false;
		queryClient.setQueryData<OpenedFile>(todosKeys.text(path), (opened) => {
			if (opened?.kind !== 'text') return opened;
			changed = true;
			return { kind: 'text', file: change(opened.file) };
		});
		return changed;
	}

	/** The same file as captured now, for a file no view holds. */
	async function captureNow(
		path: string,
	): Promise<Result<FileCapture, FileError>> {
		const { data: read, error } = await folder.files.read(path);
		if (error !== null) return Err(error);
		return Ok({ path: read.path, sha256: read.sha256 });
	}

	/**
	 * The capture a rename or delete of `path` acts on, read when it runs:
	 * the newest hash the cache confirmed for what the app edits, if it holds
	 * one. A todo's fields are what the app edits unless the detail shows its
	 * text. An invalid row is a capture of its bytes too.
	 */
	function heldCapture(path: string): FileCapture | undefined {
		const stem = todoStem(path);
		const shown = selection.current;
		const editsRow =
			stem !== undefined && !(shown?.path === path && shown.as !== 'todos');
		if (editsRow) {
			const result = rowsData()?.find((entry) => entry.stem === stem)?.result;
			if (result?.error === null) return result.data;
			if (result?.error.name === 'InvalidRow') return result.error;
		}
		const opened = textData(path);
		return opened?.kind === 'text' ? opened.file : undefined;
	}

	return {
		/** The folder listing the file browser shows. */
		list: defineQuery({
			queryKey: todosKeys.files,
			queryFn: () => folder.files.list(),
		}),
		/** One file's complete text, or its type and size when it is not editable text. */
		text(path: string) {
			return defineQuery({
				queryKey: todosKeys.text(path),
				queryFn: () => readTextFile(folder.files, path),
			});
		},
		/** Whether `path` is being renamed or deleted, which pauses its edits; read reactively. */
		isMoving(path: string) {
			trackMutations();
			return moving(path);
		},
		/** Replace the text of `path` in the cache; answers as `rows.edit` does. */
		editText(path: string, text: string) {
			if (refused() !== undefined || moving(path)) return false;
			void queryClient.cancelQueries({
				queryKey: todosKeys.text(path),
				exact: true,
			});
			const changed = mapText(path, (file) => ({ ...file, text }));
			if (!changed) return false;
			unsent.add(path);
			return (
				queryClient.isMutating({
					mutationKey: todosKeys.writeText(path),
					exact: true,
				}) < 2
			);
		},
		/** The write of one file's text, as `rows.write` is for a todo. */
		writeText(path: string) {
			return defineMutation({
				mutationKey: todosKeys.writeText(path),
				scope: { id: path },
				mutationFn: async (): Promise<
					Result<FileCapture | undefined, FileError>
				> => {
					const opened = textData(path);
					if (opened?.kind !== 'text' || !unsent.delete(path))
						return Ok(undefined);
					return folder.files.replace(opened.file, opened.file.text);
				},
				onSuccess: (saved) => {
					if (saved === undefined) return;
					mapText(path, (file) => ({ ...file, sha256: saved.sha256 }));
				},
				// Roll back: the cache takes the file as it is now.
				onError: async (error) => {
					const lost = textData(path);
					unsent.delete(path);
					const key = todosKeys.text(path);
					await queryClient.cancelQueries({ queryKey: key, exact: true });
					const read = await readTextFile(folder.files, path);
					if (read.error === null) queryClient.setQueryData(key, read.data);
					else
						await queryClient.invalidateQueries({ queryKey: key, exact: true });
					onWriteFailed({
						path,
						error,
						lost: lost?.kind === 'text' ? lost.file.text : '',
					});
				},
				onSettled: afterWrite,
			});
		},
		/** A new empty text file, shown; it never replaces an existing one. */
		createFile: defineMutation({
			mutationKey: ['todos', 'create-file'],
			mutationFn: async ({
				directory,
				name,
			}: {
				directory: string;
				name: string;
			}): Promise<Result<FileCapture, FileError | TodosError>> => {
				const why = nameProblem(directory, name);
				if (why !== undefined) return TodosError.NotStarted({ reason: why });
				return folder.files.create(joinPath(directory, name), '');
			},
			onSuccess: (created) => {
				selection.set({ path: created.path, as: 'files' });
			},
			onSettled: () =>
				Promise.all([invalidate(todosKeys.rows), invalidate(todosKeys.files)]),
		}),
		createFolder: defineMutation({
			mutationKey: ['todos', 'create-folder'],
			mutationFn: async ({
				directory,
				name,
			}: {
				directory: string;
				name: string;
			}): Promise<Result<undefined, FileError | TodosError>> => {
				const why = nameProblem(directory, name);
				if (why !== undefined) return TodosError.NotStarted({ reason: why });
				const path = joinPath(directory, name);
				const listing = queryClient.getQueryData<FileListing>(todosKeys.files);
				if (
					listing?.directories.includes(path) ||
					listing?.files.some((file) => file.path === path)
				)
					return TodosError.NotStarted({
						reason: `"${name}" already exists here.`,
					});
				return folder.files.mkdir(path);
			},
			onSettled: () => invalidate(todosKeys.files),
		}),
		/**
		 * Rename a file within its folder. A todo row renames through its
		 * table; any other file moves as exact bytes. It runs after the file's
		 * queued writes and moves what the last one confirmed. No other file
		 * moves with it, and edits of the file wait meanwhile.
		 */
		async rename(
			path: string,
			name: string,
		): Promise<
			Result<
				FileCapture | undefined,
				FileError | MoveError | TableError | TodosError
			>
		> {
			const directory = dirname(path);
			const to = joinPath(directory, name);
			const problem = nameProblem(directory, name);
			if (problem !== undefined)
				return TodosError.NotStarted({ reason: problem });
			if (to === path) return Ok(undefined);
			const stem = todoStem(path);
			const nextStem = todoStem(to);
			if (stem !== undefined && nextStem === undefined)
				return TodosError.NotStarted({
					reason: 'A todo file keeps its .md extension.',
				});
			return defineMutation({
				mutationKey: todosKeys.move(path),
				scope: { id: path },
				mutationFn: async (): Promise<
					Result<FileCapture, FileError | MoveError | TableError | TodosError>
				> => {
					let capture = heldCapture(path);
					if (capture === undefined) {
						const { data, error } = await captureNow(path);
						if (error !== null) return Err(error);
						capture = data;
					}
					return nextStem !== undefined && stem !== undefined
						? table.rename(capture, nextStem)
						: folder.files.move(capture, to);
				},
				// The cache and the open item follow the file.
				onSuccess: () => {
					if (stem !== undefined) {
						queryClient.setQueryData<TodoListing>(todosKeys.rows, (entries) =>
							entries?.flatMap((entry) => {
								if (entry.stem !== stem) return [entry];
								if (nextStem === undefined) return [];
								const result =
									entry.result.error === null
										? Ok({ ...entry.result.data, path: to })
										: entry.result;
								return [{ stem: nextStem, result }];
							}),
						);
					}
					queryClient.removeQueries({
						queryKey: todosKeys.text(path),
						exact: true,
					});
					const shown = selection.current;
					if (shown?.path === path) selection.set({ ...shown, path: to });
				},
				onSettled: () =>
					Promise.all([
						invalidate(todosKeys.rows),
						invalidate(todosKeys.files),
					]),
			})();
		},
		/**
		 * What deleting `path` would remove, for the person to confirm, and
		 * whether its latest changes are in no saved version. Only empty
		 * folders can be deleted.
		 */
		async deletionFor(
			path: string,
		): Promise<Result<Deletion, FileError | TodosError>> {
			const why = refused();
			if (why !== undefined) return TodosError.NotStarted({ reason: why });
			const listing = queryClient.getQueryData<FileListing>(todosKeys.files);
			if (listing?.directories.includes(path)) {
				const prefix = `${path}/`;
				const occupied =
					listing.files.some((file) => file.path.startsWith(prefix)) ||
					listing.directories.some((directory) => directory.startsWith(prefix));
				if (occupied)
					return TodosError.NotStarted({
						reason:
							'Only empty folders can be deleted here. Delete or move what is inside first.',
					});
				return Ok({ kind: 'folder', path });
			}
			const { data: capture, error } = await captureNow(path);
			if (error !== null) return Err(error);
			const { data: observed } = await status.fetch();
			const unversioned = observed?.changes.some(
				(change) => change.path === path,
			);
			const stem = todoStem(path);
			const result =
				stem === undefined
					? undefined
					: rowsData()?.find((entry) => entry.stem === stem)?.result;
			const title =
				result?.error === null ? result.data.row.fields.title : undefined;
			return Ok({
				kind: stem === undefined || title === undefined ? 'file' : 'todo',
				path,
				title: title?.trim() ? title : basename(path),
				capture,
				unversioned,
			});
		},
		/**
		 * Delete what was confirmed. It runs after the file's queued writes, so
		 * it removes what this app saved last; a file another program changed
		 * since is refused.
		 */
		remove(deletion: Deletion) {
			return defineMutation({
				mutationKey: todosKeys.remove(deletion.path),
				scope: { id: deletion.path },
				mutationFn: async (): Promise<
					Result<undefined, FileError | TableError | TodosError>
				> => {
					if (deletion.kind === 'folder')
						return folder.files.rmdir(deletion.path);
					const capture = heldCapture(deletion.path) ?? deletion.capture;
					return todoStem(deletion.path) !== undefined
						? table.delete(capture)
						: folder.files.remove(capture);
				},
				// The cache and the open item let the file go.
				onSuccess: () => {
					const stem = todoStem(deletion.path);
					if (stem !== undefined)
						queryClient.setQueryData<TodoListing>(todosKeys.rows, (entries) =>
							entries?.filter((entry) => entry.stem !== stem),
						);
					queryClient.removeQueries({
						queryKey: todosKeys.text(deletion.path),
						exact: true,
					});
					if (selection.current?.path === deletion.path)
						selection.set(undefined);
				},
				onSettled: () =>
					Promise.all([
						invalidate(todosKeys.rows),
						invalidate(todosKeys.files),
					]),
			})();
		},
	};
}
