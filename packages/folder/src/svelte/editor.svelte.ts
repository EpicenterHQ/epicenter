/**
 * `@epicenter/folder/svelte`: the one text editor a component types through
 * (ADR-0548, ADR-0576).
 *
 * `createTextEditor({ current, write })` opens one document's text for a
 * control. It holds `from`, the document the edit started from, and
 * `typed`, the text typed and not yet in the file, and sends each save to
 * `write` as the change from `from` to `from` holding the typed text. The
 * folder's one write merges it into the file as it is now, so lines another
 * writer changed meanwhile stay, and the typed lines win where both changed
 * the same lines; the folder logs that, and nothing is shown (ADR-0575). A
 * file's exact text is the plain case:
 *
 * ```ts
 * const text = createTextEditor({
 *   current: () => (opened.data?.kind === 'text' ? opened.data.text : undefined),
 *   write: async (change) => {
 *     const written = unwrap(await writes.write(path, change.from, change.to));
 *     return written.file === null ? 'gone' : 'landed';
 *   },
 * });
 * ```
 *
 * `createBodyEditor({ row, write })` is its row case: the document is the
 * row, its text the body, and each save goes to the table's `write`, so
 * fields another writer changed meanwhile stay too:
 *
 * ```ts
 * const body = createBodyEditor({
 *   row: () => note ?? undefined,
 *   write: async (change) => unwrap(await writes.tables.notes.write(stem, change.from, change.to)),
 * });
 * ```
 *
 * A failed save keeps what is typed, so nothing typed is lost; the next
 * `save()` tries again, and the failure itself is the caller's to show.
 * The caller decides when to call `save()`. A folder app does not build
 * these itself: its edit layer (`@epicenter/svelte/edits`) holds one per
 * path, saves it after a pause in typing, and offers its text when the file
 * is gone.
 */
import type { Row } from '../row-text.js';
import type { StoredRow, WrittenRow } from '../table.js';

/** What a save sends: the document the edit started from, and that document holding the text typed. */
export type TextChange<TDoc> = {
	readonly from: TDoc;
	readonly to: TDoc;
};

/** One document's text, opened for a control (ADR-0576). */
export type TextEditor = {
	/** What the control shows: the text typed, or the text as the file holds it; `undefined` with no document. */
	readonly text: string | undefined;
	/** The text typed and not yet in the file; `undefined` when nothing is. */
	readonly typed: string | undefined;
	/** Whether a save of the text is running. */
	readonly saving: boolean;
	/**
	 * Whether the document is gone with text typed into it: deleted
	 * elsewhere, as the cache says or a save found. Nothing saves that text;
	 * the control offers it until the person copies or discards it.
	 */
	readonly gone: boolean;
	/** Type `text`. The first change takes the document as the cache holds it as `from`. */
	change(text: string): void;
	/**
	 * Save what is typed, one save at a time, until nothing typed is
	 * unsent. Called while a save runs, it resolves when that loop ends. A
	 * failed save keeps what is typed; its error is the writer's to show. A save
	 * of a document deleted since writes nothing (a delete beats an edit it
	 * never saw), and nothing is sent while the document is gone from the
	 * cache: what is typed stays, and `gone` says so.
	 */
	save(): Promise<void>;
	/** Drop what is typed. */
	discard(): void;
};

type TextEditorOptions<TDoc> = {
	/** The document as the cache holds it now; `undefined` while it is absent or cannot be edited as text. */
	current: () => TDoc | undefined;
	/**
	 * Write the change, rejecting on failure: the folder's write for the
	 * document's path. It resolves `'gone'` when the write
	 * found no file there, which stops the editor, and `'landed'` otherwise.
	 */
	write: (change: TextChange<TDoc>) => Promise<'landed' | 'gone'>;
};

/** How a document other than plain text holds its text. */
type DocumentText<TDoc> = {
	/** The text of `doc`. */
	textOf: (doc: TDoc) => string;
	/** `doc` holding `text` in place of its own: what a save sends as `to`. */
	withText: (doc: TDoc, text: string) => TDoc;
};

/**
 * Open one document's text for a control: a file's exact text, or, with
 * `textOf` and `withText`, the text part of a larger document, such as a
 * row's body (`createBodyEditor`).
 *
 * It holds `from`, the document at the first change, then what each save
 * that landed sent, and `typed`. A save that lands with nothing typed since
 * clears both, and the control shows the file again. A save that lands
 * while typing continued makes `from` what it sent, so the next save
 * changes only what was typed since. A failed save keeps both. There is no
 * revision counter and no merge here: the folder's write merges every save
 * into the file as it is now.
 */
export function createTextEditor(
	options: TextEditorOptions<string>,
): TextEditor;
export function createTextEditor<TDoc>(
	options: TextEditorOptions<TDoc> & DocumentText<TDoc>,
): TextEditor;
export function createTextEditor<TDoc>({
	current,
	write,
	textOf = String,
	withText = (_doc, text) => text as TDoc,
}: TextEditorOptions<TDoc> & Partial<DocumentText<TDoc>>): TextEditor {
	/** The document the edit started from, then the document each landed save sent. */
	let from: TDoc | undefined = $state.raw();
	let typed: string | undefined = $state.raw();
	let running: Promise<void> | undefined = $state.raw();
	/** A save found the document deleted. */
	let deleted = $state.raw(false);

	/** Started only with something to send, so it awaits before it ends. */
	async function loop() {
		try {
			while (from !== undefined && typed !== undefined) {
				if (current() === undefined) return;
				const base = from;
				const to = withText(base, typed);
				const landed = await write({ from: base, to }).catch(
					() => 'failed' as const,
				);
				// The writer holds the error; what is typed stays.
				if (landed === 'failed') return;
				if (landed === 'gone') {
					if (from === base) deleted = true;
					return;
				}
				// Discarded, or discarded and begun again, while it ran.
				if (from !== base || typed === undefined) return;
				if (textOf(withText(base, typed)) === textOf(to)) {
					from = undefined;
					typed = undefined;
					return;
				}
				// Typing continued: the next save starts from what this one
				// sent, so it changes only what was typed since.
				from = to;
			}
		} finally {
			running = undefined;
		}
	}

	return {
		get text() {
			if (typed !== undefined) return typed;
			const doc = current();
			return doc === undefined ? undefined : textOf(doc);
		},
		get typed() {
			return typed;
		},
		get saving() {
			return running !== undefined;
		},
		get gone() {
			return typed !== undefined && (deleted || current() === undefined);
		},
		change(text) {
			if (from === undefined) {
				const doc = current();
				if (doc === undefined) return;
				from = doc;
			}
			typed = text;
		},
		save() {
			if (running !== undefined) return running;
			// Nothing to send, or no document to send it to: the loop would end
			// before it first awaits.
			if (
				from === undefined ||
				typed === undefined ||
				deleted ||
				current() === undefined
			)
				return Promise.resolve();
			running = loop();
			return running;
		},
		discard() {
			from = undefined;
			typed = undefined;
			deleted = false;
		},
	};
}

/** A body as the file stores it: line feeds, and well-formed text (ADR-0572). */
const storable = (text: string) => text.replace(/\r\n?/g, '\n').toWellFormed();

/**
 * One row's body, opened for a control: the text editor's row case. The
 * document is the row, its text the body, and a save sends the row it
 * started from and that row with the typed body, stored as the file stores
 * a body (ADR-0572), to the table's `write`.
 */
export function createBodyEditor<TFields>({
	row,
	write,
}: {
	/** The row as the cache holds it now; `undefined` while it is absent or does not read as a row. */
	row: () => StoredRow<TFields> | undefined;
	/**
	 * Write the change from `from` to `to`, rejecting on failure: the
	 * table's `write` with the row's stem. It resolves with what the write left: `null` when the row is gone, which
	 * stops the editor; a file that does not read as a row still holds what
	 * was sent.
	 */
	write: (change: TextChange<Row<TFields>>) => Promise<WrittenRow<TFields>>;
}): TextEditor {
	return createTextEditor<Row<TFields>>({
		current: () => row()?.row,
		textOf: (doc) => doc.body,
		withText: (doc, text) => ({ fields: doc.fields, body: storable(text) }),
		write: async (change) =>
			(await write(change)) === null ? 'gone' : 'landed',
	});
}
