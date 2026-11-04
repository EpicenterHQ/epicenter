/**
 * One note of a folder's note collection as an immediate editor
 * (`folder.todos.edit({ id })`): a plain object with its own reads, actions
 * and `subscribe`, which any framework adapts the way it adapts the folder.
 *
 * The editor holds nothing while nobody listens: its `subscribe` is the
 * collection's (which lists while someone listens) plus its own changes, so
 * an editor nobody reads is garbage like any object, and needs no teardown.
 */
import type {
	ClientError,
	Collection,
	FieldsOf,
	NotePatch,
	Version,
} from '@epicenter/definition/contract';
import { sameValue } from '@epicenter/definition/note';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { OpenFolderError } from './errors.js';

const log = createLogger('folder');

/**
 * One note as an immediate editor. `fields` holds each declared field and
 * `body`: each shows what was typed until its save answers, then the note,
 * and setting one saves it. The rest says whether the note is there and how
 * its saves stand.
 */
export type NoteEdit<TCollection extends Collection> = {
	/** The note's fields and body to read and bind; one accessor each, live for the editor's life. */
	readonly fields: NotePatch<TCollection>;
	/** Whether a note that reads is listed at the editor's path; false while missing, deleted or not reading. */
	exists(): boolean;
	/** Why the newest save failed; null while none has. What was typed stays. */
	error(): ClientError | OpenFolderError | null;
	/** Whether a save is out: from the keystroke until it answers. */
	saving(): boolean;
	/** What was typed and is not yet shown as saved, by field; null while the editor shows the note. */
	typed(): NotePatch<TCollection> | null;
	/** Send what was typed again, over the note as shown now; answers as `landed()` does. */
	retry(): Promise<Result<void, ClientError | OpenFolderError>>;
	/** Show the note again, dropping what was typed; a save already out still lands. */
	discard(): Promise<void>;
	/** Answers once the newest typed value's save does: at once when nothing typed is waiting. */
	landed(): Promise<Result<void, ClientError | OpenFolderError>>;
	/** Call `listener` when a read may answer differently: the editor's own, or the note's. */
	subscribe(listener: () => void): () => void;
};

/** What `edit` takes beside the note's placeholders. */
export type NoteEditOptions<TCollection extends Collection> = {
	/** Make the note on the first save when none is shown: these fields, and what was typed. */
	create?: () => FieldsOf<TCollection> & { body?: string };
};

type Entry = { [key: string]: unknown; version: Version };
type Args = Record<string, unknown>;
type Saved = Result<unknown, ClientError | OpenFolderError>;

/**
 * The editor of the note `args` names, over the collection's own writes
 * (settled, not held) and reads. Each keystroke is held by `hold` from the
 * moment it is typed until its save answers.
 */
export function editNote({
	args,
	options,
	fieldNames,
	shown,
	create,
	update,
	hold,
	subscribe,
}: {
	args: Args;
	options: { create?: () => Args };
	fieldNames: readonly string[];
	/** The note `args` names, as the collection shows it. */
	shown: () => Entry | undefined;
	create: (value: Args) => Promise<Saved>;
	update: (args: Args, patch: Args, options: { base?: Entry }) => Promise<Saved>;
	hold: <T>(write: Promise<T>) => Promise<T>;
	/** The collection's `subscribe`, which lists while someone listens. */
	subscribe: (listener: () => void) => () => void;
}) {
	/** What was typed and not yet shown as saved, by field; none shows the note. */
	let typed: Args | null = null;
	let error: ClientError | OpenFolderError | null = null;
	/** Keystrokes whose save has not answered. */
	let sending = 0;
	/** The fields typed since the last save that landed: what the next save sends. */
	let pending: Args = {};
	/**
	 * What this run of typing is made over: the version shown when it began,
	 * and each typed field as shown when its typing began. None between runs.
	 */
	let base: Entry | undefined;
	/** The newest keystroke's number: only its save is sent, and only its answer shown. */
	let newest = 0;
	/** The newest keystroke's save, answered once what it shows is shown. */
	let latest: Promise<Saved> = Promise.resolve(Ok(undefined));
	/** The saves, one at a time. */
	let running: Promise<unknown> = Promise.resolve();
	const listeners = new Set<() => void>();

	function notify() {
		for (const listener of [...listeners])
			try {
				listener();
			} catch (cause) {
				log.error(new Error('A note editor subscriber failed.', { cause }));
			}
	}

	/** Write `patch`: a new note when none is there to write over and `create` says how. */
	async function write(patch: Args): Promise<Saved> {
		if (options.create && base === undefined && !shown()) {
			const created = await create({ ...options.create(), ...args, ...patch });
			if (created.error?.name !== 'Occupied') return created;
		}
		return update(args, patch, base ? { base } : {});
	}

	/**
	 * After an older save of `patch` landed as `saved`, what the next save is
	 * made over: `saved`, unless a field still waiting changed under it since
	 * its typing began, which the next save must then surface as a clash.
	 */
	function after(saved: Entry, patch: Args): Entry {
		if (base === undefined) return saved;
		const was = base;
		const moved = Object.keys(pending).some(
			(field) => !(field in patch) && !sameValue(saved[field], was[field]),
		);
		if (!moved) return saved;
		return {
			...was,
			...Object.fromEntries(
				Object.keys(patch).map((field) => [field, saved[field]]),
			),
		};
	}

	function send() {
		const ticket = ++newest;
		base ??= shown();
		const saved = running.then(async (): Promise<Saved> => {
			// A newer keystroke is waiting: its save carries this one's typing.
			if (ticket !== newest) return Ok(undefined);
			const patch = { ...pending };
			if (Object.keys(patch).length === 0) return Ok(undefined);
			const written = await write(patch);
			if (written.error === null) {
				for (const [field, value] of Object.entries(patch))
					if (sameValue(pending[field], value)) delete pending[field];
				base =
					ticket === newest ? undefined : after(written.data as Entry, patch);
			} else if (written.error.name === 'Conflict') base = undefined;
			return written;
		});
		running = saved.catch(() => {});
		sending++;
		latest = hold(saved)
			.finally(() => {
				sending--;
				notify();
			})
			.then((result) => {
				// Shown unless a newer keystroke or a discard has moved on.
				if (ticket === newest && typed !== null) {
					if (result.error === null) typed = null;
					else error = result.error;
					notify();
				}
				return result;
			});
	}

	function set(field: string, value: unknown) {
		if (!(field in pending)) {
			const note = shown();
			if (note !== undefined) base = { ...(base ?? note), [field]: note[field] };
		}
		pending[field] = value;
		typed = { ...typed, [field]: value };
		error = null;
		send();
		notify();
	}

	/** Each field and the body: what was typed until its save answers, else the note as shown. */
	const fields = {};
	for (const field of [...fieldNames, 'body'])
		Object.defineProperty(fields, field, {
			enumerable: true,
			get() {
				if (typed !== null && field in typed) return typed[field];
				return shown()?.[field];
			},
			set: (value: unknown) => set(field, value),
		});

	async function landed(): Promise<Result<void, ClientError | OpenFolderError>> {
		while (typed !== null) {
			const ticket = newest;
			const result = await latest;
			if (ticket !== newest) continue;
			return result.error === null ? Ok(undefined) : Err(result.error);
		}
		return Ok(undefined);
	}

	return {
		fields,
		exists: () => shown() !== undefined,
		error: () => error,
		saving: () => sending > 0,
		typed: () => typed,
		retry() {
			if (typed !== null) {
				error = null;
				send();
				notify();
			}
			return landed();
		},
		async discard() {
			typed = null;
			error = null;
			base = undefined;
			pending = {};
			notify();
		},
		landed,
		subscribe(listener: () => void) {
			listeners.add(listener);
			const stopNotes = subscribe(listener);
			return () => {
				listeners.delete(listener);
				stopNotes();
			};
		},
	};
}
