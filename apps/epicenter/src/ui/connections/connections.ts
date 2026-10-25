/**
 * What Settings' AI connections share: the table Settings reads them from,
 * how each kind is named, the query key of a connection's keychain state, a
 * new connection's id, and what a person is told when something failed.
 */

import type { connectionsTables as connectionTables } from '@epicenter/ai/connection-table';

export { connectionsTables as connectionTables } from '@epicenter/ai/connection-table';

import type { ConnectionKind } from '@epicenter/ai/send';
import type { Row } from '@epicenter/folder/next';
import type { Static } from 'typebox';
import type { CliError } from '../bindings.gen';

/**
 * The tables Settings opens `so.epicenter` with: one row per AI connection,
 * `connections/<id>.md`. The schema only interprets: other fields survive a
 * save, and a file that does not fit is listed with its source and issues.
 */
/** A `connections` row's fields. */
export type ConnectionFields = Static<(typeof connectionTables)['connections']>;

/** One file of `connections/`, read through the schema. */
export type ConnectionRow = Row<(typeof connectionTables)['connections']>;

/** A row that reads as a connection. */
export type Connection = Extract<ConnectionRow, { issues: null }>;

/** A row that does not read as a connection: its source stays, with why. */
export type Unreadable = Extract<ConnectionRow, { issues: readonly unknown[] }>;

export const KIND_LABELS: Record<ConnectionKind, string> = {
	'openai-compatible': 'OpenAI-compatible endpoint',
	epicenter: 'Epicenter account',
	local: 'This computer',
};

/**
 * The kinds a new connection may have. `local` stays a kind a row may hold,
 * and `epicenter send` refuses it (`LocalNotSent`), but no app sends over it
 * yet, so it is not offered.
 */
export const OFFERED_KINDS = [
	'openai-compatible',
	'epicenter',
] as const satisfies readonly ConnectionKind[];

/** The query key of what the keychain holds for `stem`. */
export const keyStateKey = (stem: string) => ['ai-key-state', stem] as const;

/**
 * A new connection's id, which is its row's stem and its keychain name: the
 * title in lowercase letters, digits, and hyphens, numbered when taken.
 */
export function connectionId(title: string, taken: ReadonlySet<string>) {
	const base =
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'connection';
	let id = base;
	for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
	return id;
}

/** What a person is told when a key command did not run or was refused. */
export function failureText(error: CliError) {
	return error.message;
}

/** Connections by title, then by file. */
export function connectionsOf(rows: readonly ConnectionRow[]): Connection[] {
	return rows
		.filter((row): row is Connection => row.issues === null)
		.sort(
			(a, b) =>
				a.fields.title.localeCompare(b.fields.title) ||
				a.id.localeCompare(b.id),
		);
}

/** Rows whose file is not a valid connection, by file. */
export function unreadableOf(rows: readonly ConnectionRow[]): Unreadable[] {
	return rows
		.filter((row): row is Unreadable => row.issues !== null)
		.sort((a, b) => a.id.localeCompare(b.id));
}
