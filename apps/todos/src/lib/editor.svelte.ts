/**
 * Editors over saved text files (ADR-0465).
 *
 * A draft's `buffer` is the text on screen, including unsaved typing.
 * `baseline` is the saved file the next conditional save is checked against. A
 * save captures one generation of the buffer; success advances the baseline to
 * the accepted file and leaves newer typing dirty. A conflict pauses autosave
 * and keeps the input until the person chooses. Git outcomes never affect this
 * state.
 *
 * Todo rows save through their table; other text files save through raw
 * conditional writes. Both use this one draft, so the retained-draft and
 * conflict rules are the same for every file the app edits.
 */
import {
	type Entry,
	type FileTable,
	type FileVersion,
	type FolderFiles,
	patchSource,
	type SourceChange,
	sameVersion,
} from '@epicenter/app/files';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { TodoFields } from './definition.js';
import { readTextFile } from './files.js';

export type TodoEntry = Entry<TodoFields>;

/** One saved text file as its draft last accepted it. */
export type SavedText = {
	readonly path: string;
	readonly source: string;
	readonly version: FileVersion;
};

export type SaveState<T> =
	| { readonly kind: 'saved' }
	| { readonly kind: 'saving' }
	| { readonly kind: 'failed'; readonly message: string }
	| {
			readonly kind: 'conflict';
			readonly message: string;
			/** The saved file now, or undefined when it was removed. */
			readonly current: T | undefined;
	  };

/** Where a draft saves: one conditional write, and a fresh read for conflict review. */
type DraftStore<T extends SavedText> = {
	write(
		baseline: T,
		source: string,
	): Promise<Result<T, { readonly name: string; readonly message: string }>>;
	/** The saved file now, or undefined when it is gone or no longer text. */
	read(path: string): Promise<T | undefined>;
};

/** Typing batches for this long before a save; the folder adds no Git delay. */
const TYPING_BATCH_MS = 400;

export type Draft<T extends SavedText> = ReturnType<typeof createDraft<T>>;
export type TodoEditor = Draft<TodoEntry>;
export type TextFileEditor = Draft<SavedText>;

function createDraft<T extends SavedText>(
	store: DraftStore<T>,
	initial: T,
	onSaved: () => void,
) {
	let baseline = $state.raw<T>(initial);
	let buffer = $state(initial.source);
	let saveState = $state.raw<SaveState<T>>({ kind: 'saved' });
	let refusal = $state<string | undefined>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let saving: Promise<void> | undefined;

	const dirty = () => buffer !== baseline.source;

	function schedule() {
		clearTimeout(timer);
		if (saveState.kind === 'conflict') return;
		timer = setTimeout(() => void save(), TYPING_BATCH_MS);
	}

	function input(text: string) {
		buffer = text;
		refusal = undefined;
		schedule();
	}

	async function saveOnce() {
		const captured = buffer;
		const observed = baseline;
		saveState = { kind: 'saving' };
		const result = await store.write(observed, captured);
		if (result.error === null) {
			baseline = result.data;
			saveState = { kind: 'saved' };
			onSaved();
			return;
		}
		if (result.error.name === 'Conflict') {
			saveState = {
				kind: 'conflict',
				message: result.error.message,
				current: await store.read(observed.path),
			};
			return;
		}
		saveState = { kind: 'failed', message: result.error.message };
	}

	/** Save the current generation now. Resolves when no save is running. */
	async function save(): Promise<void> {
		clearTimeout(timer);
		if (saveState.kind === 'conflict') return;
		if (saving) {
			await saving;
			return dirty() ? save() : undefined;
		}
		if (!dirty()) return;
		saving = saveOnce();
		try {
			await saving;
		} finally {
			saving = undefined;
		}
		// Typing that arrived during the save is still dirty; batch it again.
		if (dirty() && saveState.kind === 'saved') schedule();
	}

	return {
		get baseline() {
			return baseline;
		},
		get buffer() {
			return buffer;
		},
		get saveState() {
			return saveState;
		},
		/** Why the last structured change was refused; typing clears it. */
		get refusal() {
			return refusal;
		},
		get dirty() {
			return dirty();
		},
		get path() {
			return baseline.path;
		},
		/** Replace the whole buffer, as a source editor does. */
		input,
		/** Record that a requested change could not be applied; the buffer is unchanged. */
		refuse(reason: string) {
			refusal = reason;
		},
		save,
		/**
		 * Same-byte observations refresh metadata without replacing input.
		 * Changed bytes are adopted only by a clean, idle draft; a dirty draft
		 * keeps its version so its next save detects the other writer.
		 */
		observe(next: T) {
			if (next.path !== baseline.path) return;
			if (sameVersion(next.version, baseline.version)) {
				baseline = next;
				return;
			}
			if (dirty() || saving || saveState.kind !== 'saved') return;
			baseline = next;
			buffer = next.source;
		},
		/** Conflict choice: discard my input and load the saved file. */
		loadSaved() {
			if (saveState.kind !== 'conflict' || saveState.current === undefined)
				return;
			baseline = saveState.current;
			buffer = saveState.current.source;
			saveState = { kind: 'saved' };
		},
		/** Conflict choice: keep my input and save it over the version I reviewed. */
		async keepMine() {
			if (saveState.kind !== 'conflict' || saveState.current === undefined)
				return;
			baseline = saveState.current;
			saveState = { kind: 'saved' };
			await save();
		},
		async retry() {
			if (saveState.kind === 'failed') saveState = { kind: 'saved' };
			await save();
		},
		/** Settle pending input before the file is renamed, deleted, or closed. */
		async settle(): Promise<boolean> {
			await save();
			return !dirty() && saveState.kind === 'saved';
		},
		/** After a rename, continue with the accepted file at its new path. */
		moved(next: T) {
			const wasDirty = dirty();
			baseline = next;
			if (!wasDirty) buffer = next.source;
		},
		dispose() {
			clearTimeout(timer);
		},
	};
}

export function createTodoEditor(
	table: FileTable<TodoFields>,
	entry: TodoEntry,
	onSaved: () => void,
): TodoEditor {
	return createDraft<TodoEntry>(
		{
			write: (baseline, source) => table.writeSource(baseline, source),
			async read(path) {
				const current = await table.get(stemOf(path));
				return current.data ?? undefined;
			},
		},
		entry,
		onSaved,
	);
}

/** A raw text file editor. Its saves are conditional writes that request no commit. */
export function createTextFileEditor(
	files: FolderFiles,
	file: SavedText,
	onSaved: () => void,
): TextFileEditor {
	return createDraft<SavedText>(
		{
			async write(baseline, source) {
				const written = await files.write(baseline.path, source, {
					expected: baseline.version,
				});
				if (written.error) return Err(written.error);
				return Ok({ path: baseline.path, source, version: written.data });
			},
			async read(path) {
				const read = await readTextFile(files, path);
				return read.data?.kind === 'text' ? read.data.file : undefined;
			},
		},
		file,
		onSaved,
	);
}

/**
 * Change frontmatter fields or the body with the preparation table updates
 * use. Source the preparation cannot change safely is refused and kept as typed.
 */
export function patchTodo(editor: TodoEditor, change: SourceChange): boolean {
	const patched = patchSource(editor.buffer, change);
	if (patched.error) {
		editor.refuse(patched.error.reason);
		return false;
	}
	editor.input(patched.data);
	return true;
}

export function stemOf(path: string): string {
	return path.slice('todos/'.length, -'.md'.length);
}
