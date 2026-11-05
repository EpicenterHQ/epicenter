/**
 * One note of a folder's note collection as an immediate editor
 * (`folder.todos.edit({ id })`): a plain object with its own reads, actions
 * and `subscribe`, which any framework adapts the way it adapts the folder.
 *
 * Typing a field, the body, or the note's whole text saves it. Saves go
 * through the folder's queue in order, one at a time, and each sends
 * everything typed since the last that landed, so a burst of keystrokes is
 * a few writes. A save never fails: while the store is out of reach it
 * waits, and the editor keeps showing what was typed (ADR-0775). Each typed
 * field takes this write; a body or whole text typed over a note that
 * changed since the typing began is settled with `settle`, against the
 * text the editor began from (ADR-0774), so neither side is lost.
 *
 * The editor holds nothing while nobody listens: its `subscribe` is the
 * collection's (which lists while someone listens) plus its own changes, so
 * an editor nobody reads is garbage like any object, and needs no teardown.
 */
import type {
	Collection,
	FieldsOf,
	NotePatch,
} from '@epicenter/definition/contract';
import { sameValue } from '@epicenter/definition/note';
import { createLogger } from 'wellcrafted/logger';
import type { Seen } from './folder.js';
import type { noteCodec } from './note-codec.js';

const log = createLogger('folder');

/**
 * One note as an immediate editor. `fields` holds each declared field and
 * `body`, and `text` the whole note: each shows what was typed until its
 * save lands, then the note, and setting one saves it.
 */
export type NoteEdit<TCollection extends Collection> = {
	/** The note's fields and body to read and bind; one accessor each, live for the editor's life. */
	readonly fields: NotePatch<TCollection>;
	/**
	 * The note's whole text, front matter and body, to read and bind: what
	 * was typed until it lands, else the file as the folder shows it (one
	 * that does not read included), and empty where there is none. Setting
	 * it saves it: a text whose front matter parses is written in house
	 * style, and one that does not is written as typed and shows in
	 * `invalid()` until it is repaired. After a save lands, `text` keeps
	 * showing what was typed for as long as the file is what that save
	 * left and differs from the typing in house style alone, so house style
	 * never rewrites text while it is typed; a change merged in shows.
	 */
	text: string;
	/** Whether a note that reads is listed at the editor's path; false while missing, deleted or not reading. */
	exists(): boolean;
	/** Whether a save is out: from the keystroke until it lands. */
	saving(): boolean;
	/** What was typed and is not yet shown as landed, by field (`text` for the whole note); null while the editor shows the note. */
	typed(): (NotePatch<TCollection> & { text?: string }) | null;
	/** Show the note again, dropping what was typed and not yet sent; a save already out still lands. */
	discard(): void;
	/** Answers once everything typed so far has landed: at once when nothing is waiting. */
	landed(): Promise<void>;
	/** Call `listener` when a read may answer differently: the editor's own, or the note's. */
	subscribe(listener: () => void): () => void;
};

/** What `edit` takes beside the note's placeholders. */
export type NoteEditOptions<TCollection extends Collection> = {
	/** The fields a save gives the note when none is there yet, beside what was typed. */
	create?: () => FieldsOf<TCollection> & { body?: string };
};

type Args = Record<string, unknown>;

/**
 * The editor over the note the collection shows as `shown()`. `save`
 * queues one write with the folder, whose text `next` makes, at the moment
 * it runs, from the text there; `landed` hears what it left.
 */
export function editNote({
	fieldNames,
	options,
	codec,
	shown,
	save,
	subscribe,
}: {
	fieldNames: readonly string[];
	options: { create?: () => Args };
	codec: ReturnType<typeof noteCodec>;
	/** The note at the editor's path, as the collection shows it. */
	shown: () => Seen | undefined;
	save: (
		next: (text: string | null, exists: boolean) => string | null,
		landed: (seen: Seen | null) => void,
	) => Promise<void>;
	/** The collection's `subscribe`, which lists while someone listens. */
	subscribe: (listener: () => void) => () => void;
}) {
	/** What was typed and not yet shown as landed: fields, and the whole text. */
	let typed: Args | null = null;
	let typedText: string | null = null;
	/**
	 * The whole text last typed and landed, and the file it left: `text`
	 * keeps showing the typing while the file is still what it left (house
	 * style may differ from it), so a save never rewrites text being typed.
	 */
	let landedText: { typed: string; left: string | null } | null = null;
	/** Fields typed since the last save that landed: what the next save sends. */
	let pending: Args = {};
	let pendingText: string | null = null;
	/** The note's text when typing of the body, or of the whole text, began (null: no note). */
	let bodyBegan: string | null = null;
	let textBegan: string | null = null;
	/** A save is queued and has not started: a keystroke now joins it. */
	let queued = false;
	/** Saves queued or running. */
	let out = 0;
	let waiters: (() => void)[] = [];
	const listeners = new Set<() => void>();

	function notify() {
		for (const listener of [...listeners])
			try {
				listener();
			} catch (cause) {
				log.error(new Error('A note editor subscriber failed.', { cause }));
			}
	}

	const shownText = () => shown()?.text ?? null;
	const waitingToSend = () =>
		pendingText !== null || Object.keys(pending).length > 0;

	/** Everything typed has landed: tell whoever waits. */
	function settled() {
		if (out > 0 || waitingToSend()) return;
		const done = waiters;
		waiters = [];
		for (const resolve of done) resolve();
	}

	/** Queue a save, unless one waiting to start will carry this keystroke. */
	function send() {
		if (queued) return;
		queued = true;
		out++;
		/** What this save sent, as it last ran. */
		let sent: { fields: Args; text: string | null; alone: boolean } = {
			fields: {},
			text: null,
			alone: false,
		};
		void save(
			(text, exists) => {
				queued = false;
				sent = {
					fields: { ...pending },
					text: pendingText,
					// Only the typed text, over the file it began from: what lands differs from it in house style alone.
					alone: text === textBegan && Object.keys(pending).length === 0,
				};
				let next = text;
				if (sent.text !== null) next = codec.edit(next, textBegan, sent.text);
				if (Object.keys(sent.fields).length > 0) {
					const change =
						!exists && options.create
							? { ...options.create(), ...sent.fields }
							: sent.fields;
					next = codec.set(next, bodyBegan, change);
				}
				return next;
			},
			(seen) => {
				for (const [field, value] of Object.entries(sent.fields))
					if (field in pending && sameValue(pending[field], value))
						delete pending[field];
				if (pendingText === sent.text) pendingText = null;
				// Typing that goes on is made over what this save left.
				const left = seen?.text ?? null;
				landedText =
					sent.text !== null && sent.alone ? { typed: sent.text, left } : null;
				if ('body' in pending) bodyBegan = left;
				if (pendingText !== null) textBegan = left;
				typed = Object.keys(pending).length === 0 ? null : { ...pending };
				typedText = pendingText;
			},
		).finally(() => {
			out--;
			notify();
			settled();
		});
	}

	function setField(field: string, value: unknown) {
		if (field === 'body' && !('body' in pending)) bodyBegan = shownText();
		pending[field] = value;
		typed = { ...typed, [field]: value };
		send();
		notify();
	}

	/** Each field and the body: what was typed until its save lands, else the note as shown. */
	const fields = {};
	for (const field of [...fieldNames, 'body'])
		Object.defineProperty(fields, field, {
			enumerable: true,
			get() {
				if (typed !== null && field in typed) return typed[field];
				return shown()?.item?.[field];
			},
			set: (value: unknown) => setField(field, value),
		});

	const editor = {
		fields,
		exists: () => (shown()?.item ?? null) !== null,
		saving: () => out > 0,
		typed: () =>
			typed === null && typedText === null
				? null
				: { ...typed, ...(typedText === null ? {} : { text: typedText }) },
		discard() {
			typed = null;
			typedText = null;
			landedText = null;
			pending = {};
			pendingText = null;
			notify();
			settled();
		},
		landed() {
			if (out === 0 && !waitingToSend()) return Promise.resolve();
			return new Promise<void>((resolve) => waiters.push(resolve));
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			const stopNotes = subscribe(listener);
			return () => {
				listeners.delete(listener);
				stopNotes();
			};
		},
	};
	Object.defineProperty(editor, 'text', {
		enumerable: true,
		get() {
			if (typedText !== null) return typedText;
			const now = shownText();
			if (landedText !== null && landedText.left === now)
				return landedText.typed;
			return now ?? '';
		},
		set(value: string) {
			if (pendingText === null) textBegan = shownText();
			pendingText = value;
			typedText = value;
			send();
			notify();
		},
	});
	return editor;
}
