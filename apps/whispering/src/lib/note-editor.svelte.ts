/**
 * One note as an editor: what the person typed until its save lands, else
 * the note as the folder query last read it. This is Svelte state on
 * purpose: unsaved typing belongs to the page showing it, not to the
 * folder or the query cache, and it must outlive a failed save.
 *
 * Setting a field saves it a moment later; saves run one at a time, each
 * sending everything typed since the last. A save that fails keeps what
 * was typed and says why (`problem()`). When the note changed elsewhere
 * since it was shown, the newer note shows under what was typed, and
 * nothing more is saved until the person keeps theirs (`retry()`, which
 * writes the typing over the newer note) or discards it (`discard()`).
 */
import type { Result } from 'wellcrafted/result';
import type { IdCollection, NotePatch, NoteWriteError } from './notes.js';

/** Typing waits this long for more before it saves. */
const SAVE_AFTER_MS = 300;

/** Every editor with typing not yet saved, so leaving the page can ask first. */
const unsavedEditors = new Set<object>();
let unsavedCount = $state(0);

/** How many editors hold typing not yet saved. */
export function unsaved(): number {
	return unsavedCount;
}

function markUnsaved(editor: object, has: boolean) {
	if (has) unsavedEditors.add(editor);
	else unsavedEditors.delete(editor);
	unsavedCount = unsavedEditors.size;
}

export type NoteEditor<C extends IdCollection> = {
	readonly fields: NotePatch<C>;
	/** Whether the note reads and is listed. */
	exists(): boolean;
	/** Why the last save did not happen, or null. */
	problem(): NoteWriteError | null;
	/** Save what was typed again, over the note as shown now. */
	retry(): void;
	/** Drop what was typed, and show the note. */
	discard(): void;
};

/** What an editor reads and writes. */
type EditSource<C extends IdCollection> = {
	/** The fields the note's kind declares, in its order. */
	readonly fieldNames: readonly string[];
	/** The note as listed now, when it reads; read reactively. */
	get(): Record<string, unknown> | undefined;
	/** Write `changes` to the note. */
	save(changes: NotePatch<C>): Promise<Result<undefined, NoteWriteError>>;
	/** The fields a save gives the note when none is there yet, beside what was typed. */
	create?: () => NotePatch<C>;
};

export function editNote<C extends IdCollection>({
	fieldNames,
	get,
	save: write,
	create,
}: EditSource<C>): NoteEditor<C> {
	let typed = $state<Record<string, unknown>>({});
	let out = $state(false);
	let problem = $state.raw<NoteWriteError | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const editor = {};

	const pending = () => Object.keys(typed).length > 0;
	const mark = () => markUnsaved(editor, pending() || out);

	function schedule() {
		mark();
		// After a change elsewhere, nothing saves until the person chooses.
		if (problem?.name === 'Changed') return;
		clearTimeout(timer);
		timer = setTimeout(() => void save(), SAVE_AFTER_MS);
	}

	async function save() {
		if (out || !pending()) return;
		out = true;
		const sent = { ...typed };
		const changes =
			get() === undefined && create ? { ...create(), ...sent } : sent;
		const saved = await write(changes as NotePatch<C>);
		out = false;
		if (saved.error !== null) problem = saved.error;
		else {
			problem = null;
			const next = { ...typed };
			for (const [field, value] of Object.entries(sent))
				if (Object.is(next[field], value)) delete next[field];
			typed = next;
		}
		mark();
		// Typing that arrived while this save was out goes next.
		if (problem === null && pending()) schedule();
	}

	const fields = {};
	for (const field of [...fieldNames, 'body'])
		Object.defineProperty(fields, field, {
			enumerable: true,
			get() {
				if (field in typed) return typed[field];
				return get()?.[field];
			},
			set(value: unknown) {
				typed = { ...typed, [field]: value };
				schedule();
			},
		});

	return {
		fields: fields as NotePatch<C>,
		exists: () => get() !== undefined,
		problem: () => problem,
		retry() {
			problem = null;
			clearTimeout(timer);
			void save();
		},
		discard() {
			clearTimeout(timer);
			typed = {};
			problem = null;
			mark();
		},
	};
}
