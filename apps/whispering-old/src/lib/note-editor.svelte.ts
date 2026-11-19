/**
 * One note as an editor: what the person typed until its save lands, else
 * the note as the folder query last read it. This is Svelte state on
 * purpose: unsaved typing belongs to the page showing it, not to the
 * folder or the query cache, and it must outlive a failed save.
 *
 * Setting a field saves it a moment later; saves run one at a time, each
 * sending everything typed since the last. A save that fails keeps what
 * was typed and says why (`problem()`).
 *
 * A field is written over the file as it is now: only its line changes, so
 * what another program wrote elsewhere in the note stays. The body is what
 * the person typed over, so its save says which body it replaces (the one
 * shown when typing began). When the note's body changed elsewhere since,
 * nothing is written: the newer note shows under what was typed, and
 * nothing more is saved until the person keeps theirs (`retry()`, which
 * writes the typing over the newer body) or discards it (`discard()`).
 *
 * The view showing an editor disposes it when it closes. Typing no save
 * has refused is saved then, without waiting out the pause; typing a save
 * refused is dropped with the view, which showed why. Either way the
 * editor stops counting as unsaved, so leaving the page no longer asks.
 */
import type { Result } from 'wellcrafted/result';
import type {
	BodyChange,
	FieldPatch,
	IdCollection,
	NotePatch,
	NoteWriteError,
} from './notes.js';

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
	/** The view closed: save typing no save refused, and stop counting as unsaved. */
	dispose(): void;
};

/** What an editor reads and writes. */
type EditSource<C extends IdCollection> = {
	/** The fields the note's kind declares, in its order. */
	readonly fieldNames: readonly string[];
	/** The note as listed now, when it reads; read reactively. */
	get(): Record<string, unknown> | undefined;
	/** Write `fields` and, when given, the body to the note. */
	save(change: {
		fields: FieldPatch<C>;
		body?: BodyChange;
	}): Promise<Result<undefined, NoteWriteError>>;
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
	/** The body the typed body replaces: as shown when typing began, null when there was no note. */
	let bodySeen: string | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	const editor = {};

	const pending = () => Object.keys(typed).length > 0;
	/** The body shown under the typing: the note's as listed, null when there is none. */
	const shownBody = () => (get()?.body as string | undefined) ?? null;
	const mark = () => markUnsaved(editor, !disposed && (pending() || out));

	function schedule() {
		mark();
		// After a change elsewhere, nothing saves until the person chooses.
		if (problem?.name === 'Changed') return;
		clearTimeout(timer);
		if (disposed) void save();
		else timer = setTimeout(() => void save(), SAVE_AFTER_MS);
	}

	async function save() {
		if (out || !pending()) return;
		out = true;
		const sent = { ...typed };
		const { body, ...fields } = sent;
		const saved = await write({
			fields: (get() === undefined && create
				? { ...create(), ...fields }
				: fields) as FieldPatch<C>,
			body:
				body === undefined
					? undefined
					: { seen: bodySeen, text: body as string },
		});
		out = false;
		if (saved.error !== null) problem = saved.error;
		else {
			problem = null;
			// The file's body is now the one sent.
			if (body !== undefined) bodySeen = body as string;
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
				if (field === 'body' && !('body' in typed)) bodySeen = shownBody();
				typed = { ...typed, [field]: value };
				schedule();
			},
		});

	return {
		fields: fields as NotePatch<C>,
		exists: () => get() !== undefined,
		problem: () => problem,
		retry() {
			// Keeping what was typed replaces the body shown now.
			if (problem?.name === 'Changed') bodySeen = shownBody();
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
		dispose() {
			if (disposed) return;
			disposed = true;
			clearTimeout(timer);
			mark();
			if (problem === null) void save();
		},
	};
}
