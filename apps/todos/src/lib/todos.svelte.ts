/**
 * The Todos product state over one opened folder.
 *
 * Two observations refresh together after saves, terminal commands, pulls,
 * and window focus: the todo rows in `todos/*.md`, and the folder listing the
 * file browser shows. The selection is a path. A todo row opens its todo
 * editor; any other file opens as raw text, or as details when it is not
 * editable text. Editors are retained per path so a selection change never
 * discards a draft. Git status comes from the folder's shared snapshot; this
 * module adds no status cache of its own.
 */
import type {
	CommitAndPushResult,
	FileListing,
	FileVersion,
	GitError,
	GitSnapshot,
	PullError,
	PullOutcome,
	TableWriteError,
} from '@epicenter/app/files';
import { createFolderTerminal } from '@epicenter/app/files/terminal';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { TodoFields } from './definition.js';
import {
	createTextFileEditor,
	createTodoEditor,
	patchTodo,
	stemOf,
	type TextFileEditor,
	type TodoEditor,
	type TodoEntry,
} from './editor.svelte.js';
import {
	ancestorsOf,
	basename,
	dirname,
	joinPath,
	nameProblem,
	readTextFile,
} from './files.js';
import type { TodosFolder } from './folder.js';
import { createTerminalSession } from './terminal.svelte.js';

export type Todos = ReturnType<typeof createTodos>;

/** A raw file the person opened. Todo rows open as todo editors instead. */
export type OpenFile =
	| { readonly kind: 'loading' }
	| { readonly kind: 'failed'; readonly message: string }
	| { readonly kind: 'text'; readonly editor: TextFileEditor }
	| { readonly kind: 'binary' | 'tooLarge'; readonly size: number };

export type Selection =
	| {
			readonly kind: 'todo';
			readonly editor: TodoEditor;
			/** The listed row, or undefined when the file left the folder. */
			readonly entry: TodoEntry | undefined;
	  }
	| { readonly kind: 'file'; readonly path: string; readonly file: OpenFile };

/** What a confirmed deletion removes, captured when the person was asked. */
export type Deletion =
	| { readonly kind: 'todo'; readonly entry: TodoEntry }
	| {
			readonly kind: 'file';
			readonly path: string;
			readonly version: FileVersion;
	  }
	| { readonly kind: 'folder'; readonly path: string };

const ROW_PATH = /^todos\/[^/]+\.md$/;
const UNSETTLED = 'Save or discard the open edits first.';

/** Library errors state failures precisely; these are the ones a person acts on. */
function describeWriteError(error: TableWriteError): string {
	if (error.name === 'Conflict')
		return error.expected === 'absent'
			? `"${basename(error.path)}" already exists here.`
			: 'The file changed after it was read, so nothing was changed. Check it and try again.';
	if (error.name === 'DirectoryNotEmpty')
		return 'The folder is not empty, so nothing was deleted.';
	return error.message;
}

export function createTodos(folder: TodosFolder) {
	const table = folder.tables.todos;
	let entries = $state.raw<TodoEntry[]>([]);
	let unreadable = $state.raw<{ path: string; message: string }[]>([]);
	let listError = $state<string | undefined>();
	let listing = $state.raw<FileListing | undefined>();
	let listingError = $state<string | undefined>();
	let git = $state.raw<GitSnapshot>(folder.git.snapshot);
	let selectedPath = $state<string | undefined>();
	/** Folders open in the file browser; kept while the browser is hidden. */
	const expanded = new SvelteSet<string>(['todos']);
	const todoEditors = new SvelteMap<string, TodoEditor>();
	const openFiles = new SvelteMap<string, OpenFile>();
	const rowPaths = $derived(new Set(entries.map((entry) => entry.path)));
	const selection = $derived.by((): Selection | undefined => {
		if (selectedPath === undefined) return undefined;
		const editor = todoEditors.get(selectedPath);
		if (editor !== undefined)
			return {
				kind: 'todo',
				editor,
				entry: entries.find((entry) => entry.path === selectedPath),
			};
		const file = openFiles.get(selectedPath);
		return file && { kind: 'file', path: selectedPath, file };
	});
	const terminal = createTerminalSession(
		createFolderTerminal(folder),
		refreshAll,
	);
	const unsubscribe = folder.git.subscribe((snapshot) => {
		git = snapshot;
	});

	function textEditorAt(path: string): TextFileEditor | undefined {
		const file = openFiles.get(path);
		return file?.kind === 'text' ? file.editor : undefined;
	}

	function allEditors(): (TodoEditor | TextFileEditor)[] {
		const editors: (TodoEditor | TextFileEditor)[] = [...todoEditors.values()];
		for (const file of openFiles.values())
			if (file.kind === 'text') editors.push(file.editor);
		return editors;
	}

	function sortEntries(list: readonly TodoEntry[]) {
		return [...list].sort((a, b) => {
			const doneA = a.fields.done === true ? 1 : 0;
			const doneB = b.fields.done === true ? 1 : 0;
			if (doneA !== doneB) return doneA - doneB;
			return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
		});
	}

	/** Show newer saved text in clean open files, and forget clean files that left the folder. */
	async function observeOpenFiles(current: FileListing) {
		const present = new Set(current.files.map((file) => file.path));
		for (const [path, file] of openFiles) {
			if (file.kind === 'loading') continue;
			if (file.kind !== 'text') {
				if (!present.has(path)) openFiles.delete(path);
				continue;
			}
			const idle = !file.editor.dirty && file.editor.saveState.kind === 'saved';
			if (!present.has(path)) {
				if (!idle) continue;
				file.editor.dispose();
				openFiles.delete(path);
				continue;
			}
			const read = await readTextFile(folder.files, path);
			if (read.data?.kind === 'text') file.editor.observe(read.data.file);
		}
	}

	async function refresh() {
		const [rows, files] = await Promise.all([
			table.list(),
			folder.files.list(),
		]);
		if (rows.error) {
			// Keep the previous observation visible; never show an empty list for a failed read.
			listError = rows.error.message;
		} else {
			listError = undefined;
			entries = sortEntries(rows.data.entries);
			unreadable = rows.data.unreadable.map((item) => ({
				path: item.path,
				message: item.error.message,
			}));
			for (const entry of rows.data.entries)
				todoEditors.get(entry.path)?.observe(entry);
		}
		if (files.error) {
			listingError = files.error.message;
		} else {
			listingError = undefined;
			listing = files.data;
			await observeOpenFiles(files.data);
		}
	}

	async function refreshAll() {
		await Promise.all([refresh(), folder.git.status()]);
	}

	function editorFor(entry: TodoEntry): TodoEditor {
		let editor = todoEditors.get(entry.path);
		if (editor === undefined) {
			editor = createTodoEditor(table, entry, () => void refresh());
			todoEditors.set(entry.path, editor);
		}
		return editor;
	}

	/** Select a path: a todo row opens its editor, any other file opens as raw text or details. */
	async function open(path: string) {
		selectedPath = path;
		for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		const known = openFiles.get(path);
		if (
			todoEditors.has(path) ||
			known?.kind === 'text' ||
			known?.kind === 'loading'
		)
			return;
		let entry = entries.find((item) => item.path === path);
		if (entry === undefined && ROW_PATH.test(path)) {
			// The list may predate a row written by the terminal or a pull.
			await refresh();
			entry = entries.find((item) => item.path === path);
		}
		if (entry !== undefined) {
			editorFor(entry);
			return;
		}
		openFiles.set(path, { kind: 'loading' });
		const read = await readTextFile(folder.files, path);
		if (openFiles.get(path)?.kind !== 'loading') return;
		openFiles.set(
			path,
			read.error
				? { kind: 'failed', message: read.error.message }
				: read.data.kind === 'text'
					? {
							kind: 'text',
							// Raw writes request no commit; recheck so the change shows as uncommitted.
							editor: createTextFileEditor(
								folder.files,
								read.data.file,
								() => void refreshAll(),
							),
						}
					: read.data,
		);
	}

	function forget(path: string) {
		todoEditors.get(path)?.dispose();
		todoEditors.delete(path);
		const file = openFiles.get(path);
		if (file?.kind === 'text') file.editor.dispose();
		openFiles.delete(path);
		if (selectedPath === path) selectedPath = undefined;
	}

	async function renameTodo(
		path: string,
		stem: string,
	): Promise<string | undefined> {
		const editor = todoEditors.get(path);
		let target = entries.find((entry) => entry.path === path);
		if (editor !== undefined) {
			if (!(await editor.settle())) return UNSETTLED;
			target = editor.baseline;
		}
		if (target === undefined) return 'This todo is no longer in the folder.';
		const renamed = await table.rename(target, stem);
		if (renamed.error) {
			await refresh();
			return describeWriteError(renamed.error);
		}
		if (editor !== undefined) {
			todoEditors.delete(path);
			editor.moved(renamed.data);
			todoEditors.set(renamed.data.path, editor);
		}
		if (selectedPath === path) selectedPath = renamed.data.path;
		await refresh();
		return undefined;
	}

	async function renameFile(
		from: string,
		to: string,
	): Promise<string | undefined> {
		const editor = textEditorAt(from);
		let expected: FileVersion;
		if (editor !== undefined) {
			if (!(await editor.settle())) return UNSETTLED;
			expected = editor.baseline.version;
		} else {
			const read = await folder.files.read(from);
			if (read.error) return read.error.message;
			expected = read.data.version;
		}
		const moved = await folder.files.move(from, to, { expected });
		if (moved.error) {
			await refreshAll();
			return describeWriteError(moved.error);
		}
		const wasSelected = selectedPath === from;
		if (editor !== undefined && !ROW_PATH.test(to)) {
			openFiles.delete(from);
			editor.moved({ ...editor.baseline, path: to });
			openFiles.set(to, { kind: 'text', editor });
		} else {
			// A file renamed into a todo row reopens as a todo.
			forget(from);
		}
		await refreshAll();
		if (wasSelected) await open(to);
		return undefined;
	}

	return {
		folder,
		terminal,
		get entries() {
			return entries;
		},
		get unreadable() {
			return unreadable;
		},
		get listError() {
			return listError;
		},
		/** Every file and directory in the folder, as last listed. */
		get listing() {
			return listing;
		},
		get listingError() {
			return listingError;
		},
		expanded,
		get git() {
			return git;
		},
		get selectedPath() {
			return selectedPath;
		},
		get selection() {
			return selection;
		},
		isTodo(path: string) {
			return rowPaths.has(path);
		},
		/** Whether any open editor has input that is not yet saved. */
		get unsaved() {
			return allEditors().some(
				(editor) => editor.dirty || editor.saveState.kind !== 'saved',
			);
		},
		get saving() {
			return allEditors().some((editor) => editor.saveState.kind === 'saving');
		},
		get saveProblems() {
			return allEditors().filter(
				(editor) =>
					editor.saveState.kind === 'failed' ||
					editor.saveState.kind === 'conflict',
			).length;
		},
		refresh,
		refreshAll,
		open,
		async create(title: string): Promise<string | undefined> {
			const created = await table.create({
				fields: { title, done: false },
				body: '',
			});
			if (created.error) return describeWriteError(created.error);
			await refresh();
			selectedPath = created.data.path;
			editorFor(created.data);
			return undefined;
		},
		/** Toggle completion. An open editor receives it in its buffer instead of racing it. */
		async toggle(entry: TodoEntry): Promise<string | undefined> {
			const editor = todoEditors.get(entry.path);
			const done = !(entry.fields.done === true);
			if (editor !== undefined) {
				if (!patchTodo(editor, { fields: { done } })) return editor.refusal;
				await editor.save();
				return undefined;
			}
			const updated = await table.update(entry, {
				fields: { done } satisfies Partial<TodoFields>,
			});
			await refresh();
			return updated.error ? describeWriteError(updated.error) : undefined;
		},
		/**
		 * Rename a file within its folder. A todo row renames through its table,
		 * so its attachment moves with it; any other file moves as exact bytes,
		 * checked against the version its editor saw or the version read now.
		 */
		async rename(path: string, name: string): Promise<string | undefined> {
			const directory = dirname(path);
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const to = joinPath(directory, name);
			if (to === path) return undefined;
			if (rowPaths.has(path) || todoEditors.has(path)) {
				if (!ROW_PATH.test(to)) return 'A todo file keeps its .md extension.';
				return renameTodo(path, stemOf(to));
			}
			return renameFile(path, to);
		},
		/** A new empty text file; it never replaces an existing one. */
		async createFile(
			directory: string,
			name: string,
		): Promise<string | undefined> {
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const path = joinPath(directory, name);
			if (listing?.directories.includes(path))
				return `"${name}" already exists here.`;
			const written = await folder.files.write(path, '', {
				expected: 'absent',
			});
			if (written.error) return describeWriteError(written.error);
			await refreshAll();
			await open(path);
			return undefined;
		},
		async createFolder(
			directory: string,
			name: string,
		): Promise<string | undefined> {
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const path = joinPath(directory, name);
			if (
				listing?.directories.includes(path) ||
				listing?.files.some((file) => file.path === path)
			)
				return `"${name}" already exists here.`;
			const made = await folder.files.mkdir(path);
			if (made.error) return describeWriteError(made.error);
			if (directory !== '') expanded.add(directory);
			await refresh();
			return undefined;
		},
		/**
		 * Capture what deleting `path` would remove, for the person to confirm.
		 * Pending typing is saved first; a draft that cannot save refuses, so no
		 * deletion discards input. Only empty folders can be deleted.
		 */
		async deletionFor(path: string): Promise<Result<Deletion, string>> {
			if (listing?.directories.includes(path)) {
				const prefix = `${path}/`;
				const occupied =
					listing.files.some((file) => file.path.startsWith(prefix)) ||
					listing.directories.some((directory) => directory.startsWith(prefix));
				if (occupied)
					return Err(
						'Only empty folders can be deleted here. Delete or move what is inside first.',
					);
				return Ok({ kind: 'folder', path });
			}
			const todo = todoEditors.get(path);
			if (todo !== undefined) {
				if (!(await todo.settle())) return Err(UNSETTLED);
				// The listed entry carries the current attachment when it is the same file.
				const listed = entries.find((item) => item.path === path);
				return Ok({
					kind: 'todo',
					entry:
						listed?.version.sha256 === todo.baseline.version.sha256
							? listed
							: todo.baseline,
				});
			}
			const entry = entries.find((item) => item.path === path);
			if (entry !== undefined) return Ok({ kind: 'todo', entry });
			const text = textEditorAt(path);
			if (text !== undefined) {
				if (!(await text.settle())) return Err(UNSETTLED);
				return Ok({ kind: 'file', path, version: text.baseline.version });
			}
			const read = await folder.files.read(path);
			if (read.error) return Err(read.error.message);
			return Ok({ kind: 'file', path, version: read.data.version });
		},
		/** Delete exactly what was confirmed; a file that changed since is refused. */
		async remove(deletion: Deletion): Promise<string | undefined> {
			if (deletion.kind === 'folder') {
				const removed = await folder.files.rmdir(deletion.path);
				await refresh();
				return removed.error ? describeWriteError(removed.error) : undefined;
			}
			const path =
				deletion.kind === 'todo' ? deletion.entry.path : deletion.path;
			// The confirmation is modal, but a save may have started or failed since the capture.
			const editor = todoEditors.get(path) ?? textEditorAt(path);
			if (editor && (editor.dirty || editor.saveState.kind !== 'saved'))
				return UNSETTLED;
			const removed =
				deletion.kind === 'todo'
					? await table.delete(deletion.entry)
					: await folder.files.remove(path, { expected: deletion.version });
			if (removed.error) {
				await refreshAll();
				return describeWriteError(removed.error);
			}
			forget(path);
			await refreshAll();
			return undefined;
		},
		/** Commit current saved files and push. Unsaved editor input is not included. */
		commitAndPush(): Promise<CommitAndPushResult> {
			return folder.git.commitAndPush();
		},
		/** Fetch, then apply the remote only as a clean fast-forward. Never runs on its own. */
		async pull(): Promise<Result<PullOutcome, PullError | GitError>> {
			const fetched = await folder.git.fetch();
			if (fetched.error) return Err(fetched.error);
			const pulled = await folder.git.pullFastForward();
			await refresh();
			return pulled;
		},
		/**
		 * Save what can still be saved, then release the folder. A draft that
		 * cannot save (a conflict or failure) ends with the page; the view asks
		 * before the page is left while any draft is unsaved.
		 */
		async close() {
			for (const editor of allEditors()) {
				await editor.settle();
				editor.dispose();
			}
			unsubscribe();
			await folder.close();
		},
	};
}
