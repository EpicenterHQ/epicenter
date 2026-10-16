/**
 * The `connections` table of Epicenter's own folder, `so.epicenter`
 * (ADR-0557): one file per AI connection, `connections/<id>.md`, whose stem
 * is the connection's id. A row holds what may follow a person to every
 * machine: the kind, a title, and the model. It never holds an endpoint or
 * a key; those live in this computer's keychain under the same id
 * (`send.ts`), so an edit synced from elsewhere cannot send a key somewhere
 * new.
 *
 * {@link epicenterDefinition} is `so.epicenter`'s whole declaration. The CLI
 * publishes it on the desktop (`packages/cli/src/epicenter-folder.ts`) and a
 * browser page opens its origin's `so.epicenter` with it (ADR-0581), so the
 * two never publish different bytes.
 */

import { defineFolder, defineTable, field } from '@epicenter/folder';
import { CONNECTION_KINDS } from './send.js';

/** Epicenter's own folder, by its scope. */
export const CONNECTIONS_FOLDER_ID = 'so.epicenter';

export const connectionsTable = defineTable({
	fields: {
		kind: field.select(CONNECTION_KINDS),
		title: field.string(),
		/** The model a request names when its caller names none. Empty for a local connection, which uses the active local model. */
		model: field.string(),
	},
});

/** `so.epicenter`'s declaration: today, its `connections` table alone. */
export const epicenterDefinition = defineFolder({
	title: 'Epicenter',
	kv: {},
	tables: { connections: connectionsTable },
});

/**
 * A new connection's id, which is its row's stem and its saved key's name:
 * the title in lowercase letters, digits, and hyphens, numbered when taken.
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
