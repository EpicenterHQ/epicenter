/**
 * The demo's reply notes, in memory: what the Messages folder holds, for
 * fictional conversations, forgotten on reload. The demo runs the real send
 * owner (`createMessages`) over these and a journal in memory.
 */
import type { MessagesContract } from '@epicenter/cli/messages-contract';
import type { Replies } from '@epicenter/cli/messages-outbox';
import {
	ClientError,
	type NoteOf,
	type Version,
} from '@epicenter/definition/contract';
import { Ok } from 'wellcrafted/result';

type Note = NoteOf<MessagesContract['collections']['replies']>;

export function createMemoryReplies(): Replies {
	const notes = new Map<string, Note>();
	let versions = 0;
	// SAFETY: a version is opaque; the demo's only need to differ.
	const nextVersion = () => `demo-${++versions}` as Version;
	const pathOf = (id: string) => `replies/${id}.md`;
	return {
		async list() {
			return Ok({
				items: [...notes.values()].map((note) => ({ ...note })),
				invalid: [],
			});
		},
		async get({ id }) {
			const note = notes.get(id);
			return note ? Ok({ ...note }) : ClientError.NotFound({ path: pathOf(id) });
		},
		async create(value) {
			if (notes.has(value.id))
				return ClientError.Occupied({ path: pathOf(value.id) });
			const note = { ...value, body: value.body ?? '', version: nextVersion() };
			notes.set(value.id, note);
			return Ok({ ...note });
		},
		async update({ id }, patch, { over }) {
			const note = notes.get(id);
			if (!note) return ClientError.NotFound({ path: pathOf(id) });
			if (note.version !== over)
				return ClientError.Conflict({ path: pathOf(id), current: note.version });
			const next = { ...note, ...patch, version: nextVersion() };
			notes.set(id, next);
			return Ok({ ...next });
		},
		async replace({ id }) {
			// Every demo note reads, so none needs repair.
			return notes.has(id)
				? ClientError.Invalid({ path: pathOf(id), issues: [] })
				: ClientError.NotFound({ path: pathOf(id) });
		},
		async delete({ id }, { over }) {
			const note = notes.get(id);
			if (!note) return ClientError.NotFound({ path: pathOf(id) });
			if (note.version !== over)
				return ClientError.Conflict({ path: pathOf(id), current: note.version });
			notes.delete(id);
			return Ok(undefined);
		},
	};
}
