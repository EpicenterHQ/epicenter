/**
 * Compile-time tests for the typed client a contract derives. Compiled by
 * `tsc --noEmit` with the package; nothing runs at test time.
 *
 * What these prove: placeholders come from the path (`{id}.{ext}` gives both),
 * fields come from plain JSON Schema with `required` deciding optionality,
 * a `.md` path gives a note client and any other a file client, `create`
 * takes placeholders and value in one object, and every write needs `over`.
 */
import { Type } from 'typebox';
import type { Result } from 'wellcrafted/result';
import type { ConformanceIssue } from '../declaration.js';
import {
	type Client,
	defineContract,
	type FileEntryOf,
	type FileOf,
	type NoteOf,
	type PlaceholdersOf,
	type Version,
} from './index.js';

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: { expected: Y; got: X };
type Expect<T extends true> = T;

const recorder = defineContract({
	name: 'whispering',
	collections: {
		recordings: {
			path: 'recordings/{id}.md',
			fields: {
				title: { type: 'string' },
				durationMs: { type: 'number' },
				status: { enum: ['draft', 'done'] },
				recordedAt: Type.String({ format: 'date-time' }),
			},
			required: ['title'],
		},
		audio: { path: 'recordings/{id}.{ext}' },
		journal: { path: 'journal/{date}.md' },
		settings: { path: 'settings.md', fields: { theme: { type: 'string' } } },
	},
});
type Recorder = typeof recorder;
type Recordings = Recorder['collections']['recordings'];
type Audio = Recorder['collections']['audio'];

export type Placeholders = [
	Expect<Equal<PlaceholdersOf<Audio>, { id: string; ext: string }>>,
	Expect<Equal<PlaceholdersOf<Recordings>, { id: string }>>,
	Expect<Equal<PlaceholdersOf<Recorder['collections']['settings']>, {}>>,
];

export type Reads = [
	Expect<
		Equal<
			NoteOf<Recordings>,
			{
				id: string;
				title: string;
				durationMs?: number;
				status?: 'draft' | 'done';
				recordedAt?: string;
				body: string;
				version: Version;
			}
		>
	>,
	Expect<
		Equal<
			NoteOf<Recorder['collections']['journal']>,
			{ date: string; body: string; version: Version }
		>
	>,
	Expect<
		Equal<
			FileOf<Audio>,
			{ id: string; ext: string; bytes: Uint8Array; version: Version }
		>
	>,
	Expect<
		Equal<FileEntryOf<Audio>, { id: string; ext: string; version: Version }>
	>,
];

declare const client: Client<Recorder>;
declare const version: Version;

export async function writes() {
	const created = await client.recordings.create({ id: 'a', title: 'Standup' });
	const createdType: Expect<
		Equal<
			typeof created extends Result<infer T, unknown> ? T : never,
			NoteOf<Recordings>
		>
	> = true;
	await client.recordings.create({ id: 'a', title: 'x', body: 'Body\n' });
	await client.recordings.update(
		{ id: 'a' },
		{ durationMs: 5 },
		{ over: version },
	);
	await client.recordings.update(
		{ id: 'a' },
		{ body: 'new' },
		{ over: version },
	);
	await client.recordings.delete({ id: 'a' }, { over: version });
	await client.audio.create({ id: 'a', ext: 'webm', bytes: new Uint8Array() });
	await client.audio.update(
		{ id: 'a', ext: 'webm' },
		{ bytes: new Uint8Array() },
		{ over: version },
	);
	await client.settings.create({ theme: 'dark' });
	await client.settings.get({});
	const listed = await client.recordings.list();
	if (listed.error === null) {
		const invalid: { path: string; issues: ConformanceIssue[] }[] =
			listed.data.invalid;
		const titles: string[] = listed.data.items.map((note) => note.title);
		return [createdType, invalid, titles];
	}
	return [createdType];
}

export async function refusals() {
	// @ts-expect-error: a required field is missing from create
	await client.recordings.create({ id: 'a' });
	// @ts-expect-error: a placeholder is missing from create
	await client.recordings.create({ title: 'x' });
	// @ts-expect-error: {id}.{ext} needs both placeholders
	await client.audio.create({ id: 'a', bytes: new Uint8Array() });
	// @ts-expect-error: a field's type comes from its JSON Schema
	await client.recordings.create({ id: 'a', title: 1 });
	const other = { status: 'other' } as const;
	// @ts-expect-error: an enum field takes only its values
	await client.recordings.update({ id: 'a' }, other, { over: version });
	// @ts-expect-error: an update must pass the version it read
	await client.recordings.update({ id: 'a' }, { title: 'x' });
	// @ts-expect-error: a delete must pass the version it read
	await client.audio.delete({ id: 'a', ext: 'webm' });
	// @ts-expect-error: a version is not any string
	await client.recordings.delete({ id: 'a' }, { over: 'abc' });
	// @ts-expect-error: a file collection has no body
	await client.audio.create({ id: 'a', ext: 'webm', body: '' });
	// @ts-expect-error: a collection the contract does not declare
	client.photos;
}
