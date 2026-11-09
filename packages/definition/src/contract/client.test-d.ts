/**
 * Compile-time tests for the typed client a contract derives. Compiled by
 * `tsc --noEmit` with the package; nothing runs at test time.
 *
 * What these prove: placeholders come from the path (`{id}.{ext}` gives both),
 * fields come from plain JSON Schema with `required` deciding optionality,
 * nested fields keep their shape, and no read carries a version. The
 * folder's writes are typed in `@epicenter/folder`'s own type tests.
 */
import { Type } from 'typebox';
import {
	defineContract,
	type FieldsOf,
	type FileEntryOf,
	type FileOf,
	type InvalidNoteOf,
	type NoteOf,
	type NotePatch,
	type PlaceholdersOf,
} from './index.js';
import type { ConformanceIssue } from './issues.js';

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: { expected: Y; got: X };
type Expect<T extends true> = T;

const recorder = defineContract({
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
			}
		>
	>,
	Expect<
		Equal<
			NoteOf<Recorder['collections']['journal']>,
			{ date: string; body: string }
		>
	>,
	Expect<Equal<FileOf<Audio>, { id: string; ext: string; bytes: Uint8Array }>>,
	Expect<Equal<FileEntryOf<Audio>, { id: string; ext: string }>>,
	Expect<
		Equal<
			InvalidNoteOf<Recordings>,
			{
				id: string;
				path: string;
				issues: ConformanceIssue[];
				text: string | null;
			}
		>
	>,
	Expect<
		Equal<
			NotePatch<Recorder['collections']['settings']>,
			{ theme?: string; body?: string }
		>
	>,
];

/** Nested fields: an array of objects, a union of objects told apart by a `const`, and any JSON (`{}`). */
const tutor = defineContract({
	collections: {
		chats: {
			path: 'chats/{id}.md',
			fields: {
				focus: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							entryId: { type: 'string' },
							text: { type: 'string' },
						},
						required: ['entryId', 'text'],
					},
				},
			},
			required: ['focus'],
		},
		messages: {
			path: 'messages/{chat}/{id}.md',
			fields: {
				parts: {
					type: 'array',
					items: {
						anyOf: [
							{
								type: 'object',
								properties: {
									type: { const: 'text' },
									text: { type: 'string' },
								},
								required: ['type', 'text'],
							},
							{
								type: 'object',
								properties: { type: { const: 'tool-call' }, input: {} },
								required: ['type', 'input'],
							},
						],
					},
				},
			},
			required: ['parts'],
		},
	},
});
type Tutor = typeof tutor;

export type Nested = [
	Expect<
		Equal<
			NoteOf<Tutor['collections']['chats']>['focus'],
			{ entryId: string; text: string }[]
		>
	>,
	Expect<
		Equal<
			PlaceholdersOf<Tutor['collections']['messages']>,
			{ chat: string; id: string }
		>
	>,
	Expect<
		Equal<
			NoteOf<Tutor['collections']['messages']>['parts'],
			({ type: 'text'; text: string } | { type: 'tool-call'; input: unknown })[]
		>
	>,
];

export const nestedRefusals = [
	// @ts-expect-error: a nested object needs its required keys
	{ focus: [{ entryId: 'a' }] } satisfies FieldsOf<
		Tutor['collections']['chats']
	>,
	{
		// @ts-expect-error: a part is one of the union's objects
		parts: [{ type: 'image' }],
	} satisfies FieldsOf<Tutor['collections']['messages']>,
];
