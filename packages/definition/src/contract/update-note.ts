/**
 * The one rule for a person's edit that meets a `Conflict` (the note changed
 * since it was read), for every editor of every app, over the device or the
 * repository alike.
 *
 * The edit is a patch of fields (the body counts as one) made over `base`,
 * the note as its writer saw it. When the note moved, it is read again, and
 * each field of the patch is judged on its own:
 *
 * | the field now is                 | so                                   |
 * | -------------------------------- | ------------------------------------ |
 * | as `base` had it                 | apply the edit's value over it again |
 * | already the edit's value         | nothing to write                     |
 * | anything else                    | the `Conflict`: someone changed it   |
 *
 * So an edit carries over another writer's change to other fields, and
 * never silently replaces their change to the same one. A note deleted since
 * is a `Conflict` whose `current` is null (an app may re-create it).
 */
import type { InferError } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { sameValue } from '../note/canonical.js';
import {
	ClientError,
	type NoteClient,
	type NoteOf,
	type NotePatch,
	type PlaceholdersOf,
	type Version,
} from './client.js';
import type { Collection } from './contract.js';

type NotFound = InferError<typeof ClientError.NotFound>;
type Conflict = InferError<typeof ClientError.Conflict>;
type Invalid = InferError<typeof ClientError.Invalid>;
type Unavailable = InferError<typeof ClientError.Unavailable>;

/** How many times an edit is written before writes that keep racing it win. */
const ATTEMPTS = 5;

/**
 * Write `patch` to the note `args` names, made over `base`: the note as its
 * writer saw it, at least its version and the fields the patch changes (a
 * field missing from `base` was absent). A read note is a `base`.
 *
 * @example
 * ```ts
 * const saved = await updateNote(device.todos, { id }, { title }, { base: todo });
 * if (saved.error?.name === 'Conflict') showBoth(todo.title, title);
 * ```
 */
export async function updateNote<TCollection extends Collection>(
	notes: Pick<NoteClient<TCollection>, 'get' | 'update'>,
	args: PlaceholdersOf<TCollection>,
	patch: NotePatch<TCollection>,
	{ base }: { base: { version: Version } & NotePatch<TCollection> },
): Promise<
	Result<NoteOf<TCollection>, NotFound | Conflict | Invalid | Unavailable>
> {
	let seen: Record<string, unknown> = base;
	let over = base.version;
	let remaining: Record<string, unknown> = patch;
	for (let attempt = 1; ; attempt++) {
		const written = await notes.update(
			args,
			remaining as NotePatch<TCollection>,
			{ over },
		);
		if (written.error?.name !== 'Conflict') return written;
		const { path, current } = written.error;
		if (current === null || attempt === ATTEMPTS) return written;
		const read = await notes.get(args);
		if (read.error?.name === 'NotFound')
			return ClientError.Conflict({ path, current: null });
		if (read.error !== null) return read;
		const now: Record<string, unknown> = read.data;
		const again: Record<string, unknown> = {};
		for (const [field, value] of Object.entries(remaining)) {
			if (sameValue(now[field], value)) continue;
			if (!sameValue(now[field], seen[field]))
				return ClientError.Conflict({ path, current: read.data.version });
			again[field] = value;
		}
		if (Object.keys(again).length === 0) return Ok(read.data);
		seen = now;
		over = read.data.version;
		remaining = again;
	}
}
