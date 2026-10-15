/**
 * Epicenter's own folder, `so.epicenter` (ADR-0539): which apps are
 * installed, and Epicenter's settings, as files a person or an agent can read,
 * edit, and version.
 *
 * Epicenter creates this folder, so it owns the schema and opens it with
 * `openFolder`, which publishes `epicenter.json`. Each installed app is a row,
 * `apps/<app-id>.md`, holding where it came from and the commit it runs. The
 * row is a fact the shell established: what may run on this machine is
 * `approvals.json` in app data, which only the shell writes, so a row synced
 * from another machine runs nothing here until it is approved here. Built-in
 * apps are not rows.
 */

import {
	type CreateRowOf,
	defineFolder,
	defineTable,
	type Folder,
	field,
} from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/tauri';
import { Type } from 'typebox';
import type { InstalledApp } from '../ui/bindings.gen';

/** The folder's scope, which the shell registered for this window and Settings. */
export const EPICENTER_FOLDER_ID = 'so.epicenter';

export const epicenterDefinition = defineFolder({
	title: 'Epicenter',
	kv: {
		/** The app each folder opens in by default, by folder id. */
		defaultApp: field.json(Type.Record(Type.String(), Type.String())),
	},
	tables: {
		/** One row per installed app, at `apps/<app-id>.md`. */
		apps: defineTable({
			fields: {
				title: field.string(),
				/** The Git URL or path it was installed from. */
				source: field.string(),
				/** The commit it runs. */
				commit: field.string(),
			},
		}),
	},
});

type AppRow = CreateRowOf<typeof epicenterDefinition.tables.apps>;

/** The row an installed app that runs should have. */
export function appRow(app: InstalledApp): AppRow {
	return { title: app.title, source: app.source, commit: app.commit };
}

/**
 * Record every installed app that runs in Epicenter's own folder. Opens the
 * folder for the writes and closes it after. Returns the first problem, if
 * any; the rows it could write are written.
 */
export async function recordInstalledApps(
	apps: readonly InstalledApp[],
): Promise<string | undefined> {
	if (!apps.some((app) => app.state.kind === 'ready')) return undefined;
	const { data: folder, error } = await openFolder({
		id: EPICENTER_FOLDER_ID,
		definition: epicenterDefinition,
	});
	if (error !== null) return error.message;
	try {
		return await writeAppRows(folder, apps);
	} finally {
		await folder.close();
	}
}

/**
 * Write a row for every installed app that runs and whose row says otherwise,
 * keeping any other field and the body a person or an agent added.
 */
export async function writeAppRows(
	folder: Folder<typeof epicenterDefinition>,
	apps: readonly InstalledApp[],
): Promise<string | undefined> {
	for (const app of apps) {
		if (app.state.kind !== 'ready') continue;
		const fields = appRow(app);
		const { data: stored, error: readError } = await folder.tables.apps.get(
			app.id,
		);
		if (readError !== null) return readError.message;
		if (stored === undefined) {
			const { error: createError } = await folder.tables.apps.create(
				{ fields, body: '' },
				{ stem: app.id },
			);
			if (createError !== null) return createError.message;
			continue;
		}
		const current = stored.row.fields;
		if (
			current.title === fields.title &&
			current.source === fields.source &&
			current.commit === fields.commit
		)
			continue;
		const { error: replaceError } = await folder.tables.apps.save(stored, {
			fields: { ...current, ...fields },
			body: stored.row.body,
		});
		if (replaceError !== null) return replaceError.message;
	}
	return undefined;
}
