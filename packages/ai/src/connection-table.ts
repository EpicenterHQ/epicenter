/**
 * The `connections` table of Epicenter's own folder, `so.epicenter`
 * (ADR-0557): one file per AI connection, `connections/<id>.md`, whose stem
 * is the connection's id. A row holds what may follow a person to every
 * machine: the kind, a title, and the model. It never holds an endpoint or
 * a key; those live in this computer's keychain under the same id
 * (`send.ts`), so an edit synced from elsewhere cannot send a key somewhere
 * new.
 *
 * `so.epicenter`'s declaration (`epicenterDefinition` in
 * `packages/cli/src/epicenter-folder.ts`) includes this table. Epicenter
 * publishes it; an installed app that uses connections reads `so.epicenter`
 * through {@link connectionsDefinition}, by ID, which never publishes.
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

/** `so.epicenter` read through its `connections` table alone. */
export const connectionsDefinition = defineFolder({
	title: 'Epicenter',
	tables: { connections: connectionsTable },
});
