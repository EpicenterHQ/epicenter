/**
 * `whispering-connection read|set <transcription|text>`: Whispering's two
 * connection rows in Epicenter's own folder, `so.epicenter`, for the desktop
 * shell (ADR-0557). The shell runs these for Whispering's window, so the
 * window opens no second folder for its connections.
 *
 * The command takes no path. The folder is `so.epicenter` under the
 * Epicenter folder (`resolveAppPaths().folderDir`, which the shell sets),
 * and the operation names one of two fixed rows
 * (`WHISPERING_CONNECTION_IDS`). Each run opens that directory with
 * `@epicenter/folder/bun`, reads or saves the one row, and closes it. A save
 * takes the folder's save lock, as Settings' saves through the shell do
 * (ADR-0562), and merges from the base the caller read, so an edit that
 * landed meanwhile stays. It needs no account, keychain, network, Git, or
 * `epicenter.json`.
 *
 * Reading a missing `so.epicenter` answers no row and creates nothing. A
 * save creates it, as the shell creates Epicenter's own folder when it
 * grants it, but only inside an Epicenter folder that is there; a link or a
 * file at `so.epicenter` is refused.
 */

import { lstat, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
	CONNECTIONS_FOLDER_ID,
	type ConnectionRow,
	connectionsTables,
	isConnectionRowSetInput,
	WHISPERING_CONNECTION_IDS,
	type WhisperingConnection,
} from '@epicenter/ai/connection-table';
import { type Folder, openFolder, type Row } from '@epicenter/folder/bun';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { resolveAppPaths } from './app-paths.ts';
import { EXIT, writeErr, writeJson, writeOut } from './output.ts';
import { finishBeforeExit } from './stop.ts';

export const ConnectionRowError = defineErrors({
	/** The operation or the input is not one this command takes. */
	InvalidInput: ({ reason }: { reason: string }) => ({
		message: reason,
		reason,
	}),
	/** `so.epicenter`, or the Epicenter folder holding it, cannot be used. */
	FolderUnusable: ({ reason }: { reason: string }) => ({
		message: reason,
		reason,
	}),
	/** The row could not be read. */
	ReadFailed: ({ path, reason }: { path: string; reason: string }) => ({
		message: `${path} could not be read: ${reason}`,
		path,
		reason,
	}),
	/** The save was refused or failed; the file is as it was. */
	SaveFailed: ({ path, reason }: { path: string; reason: string }) => ({
		message: `${path} was not changed: ${reason}`,
		path,
		reason,
	}),
});
export type ConnectionRowError = InferErrors<typeof ConnectionRowError>;

type StoredRow = Row<(typeof connectionsTables)['connections']>;

function connectionOf(
	operation: string,
): Result<WhisperingConnection, ConnectionRowError> {
	if (Object.hasOwn(WHISPERING_CONNECTION_IDS, operation))
		return Ok(operation as WhisperingConnection);
	return ConnectionRowError.InvalidInput({
		reason: `epicenter whispering-connection takes transcription or text, not '${operation}'`,
	});
}

/** The row's path as a person finds it under the Epicenter folder. */
const rowPath = (connection: WhisperingConnection) =>
	`${CONNECTIONS_FOLDER_ID}/connections/${WHISPERING_CONNECTION_IDS[connection]}.md`;

/**
 * Whether `so.epicenter` under `folderDir` is a directory to open: `true`, or
 * `false` when it is missing and `create` is not asked. With `create`, a
 * missing one is made inside the Epicenter folder, never the Epicenter
 * folder itself.
 */
async function connectionsDirectory(
	folderDir: string,
	create: boolean,
): Promise<Result<boolean, ConnectionRowError>> {
	const root = join(folderDir, CONNECTIONS_FOLDER_ID);
	const unusable = (reason: string) =>
		ConnectionRowError.FolderUnusable({ reason });
	const kind = async () => {
		try {
			const stats = await lstat(root);
			return stats.isDirectory() ? 'directory' : 'other';
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
			throw cause;
		}
	};
	try {
		let found = await kind();
		if (found === 'missing' && create) {
			const parent = await stat(folderDir).catch(() => undefined);
			if (!parent?.isDirectory())
				return unusable(
					`The Epicenter folder ${folderDir} is not there, so ${CONNECTIONS_FOLDER_ID} was not created in it.`,
				);
			await mkdir(root).catch((cause: NodeJS.ErrnoException) => {
				if (cause.code !== 'EEXIST') throw cause;
			});
			found = await kind();
		}
		if (found === 'missing') return Ok(false);
		if (found === 'other')
			return unusable(
				`${root} is a link or not a directory, so it was not opened.`,
			);
		return Ok(true);
	} catch (cause) {
		return unusable(`${root} could not be used: ${extractErrorMessage(cause)}`);
	}
}

/** Open `so.epicenter` with its `connections` table, run `work`, and close it. */
async function withConnections<T>(
	folderDir: string,
	work: (
		folder: Folder<typeof connectionsTables>,
	) => Promise<Result<T, ConnectionRowError>>,
): Promise<Result<T, ConnectionRowError>> {
	const opened = await openFolder({
		directory: join(folderDir, CONNECTIONS_FOLDER_ID),
		tables: connectionsTables,
	});
	if (opened.error !== null)
		return ConnectionRowError.FolderUnusable({ reason: opened.error.message });
	try {
		return await work(opened.data);
	} finally {
		await opened.data.close();
	}
}

/** A stored row as the command answers it: source, issues, and the schema's fields. */
function answerOf(row: StoredRow): ConnectionRow {
	if (row.issues !== null)
		return { text: row.text, issues: row.issues, fields: null };
	const { kind, title, model } = row.fields;
	return { text: row.text, issues: null, fields: { kind, title, model } };
}

/**
 * The row `operation` names in `so.epicenter` under `folderDir`, or `null`
 * when it, or `so.epicenter`, is missing. Reading creates nothing.
 */
export async function readConnectionRow(
	folderDir: string,
	operation: string,
): Promise<Result<ConnectionRow | null, ConnectionRowError>> {
	const { data: connection, error } = connectionOf(operation);
	if (error !== null) return Err(error);
	const { data: present, error: directoryError } = await connectionsDirectory(
		folderDir,
		false,
	);
	if (directoryError !== null) return Err(directoryError);
	if (!present) return Ok(null);
	return withConnections(folderDir, async (folder) => {
		const { data: row, error: readError } = await folder.tables.connections.get(
			WHISPERING_CONNECTION_IDS[connection],
		);
		if (readError !== null)
			return ConnectionRowError.ReadFailed({
				path: rowPath(connection),
				reason: readError.message,
			});
		return Ok(row === undefined ? null : answerOf(row));
	});
}

/**
 * Save `input`'s field assignments to the row `operation` names, merged from
 * `input.base`, and answer the row as sent. `input` is untrusted JSON: only
 * `ConnectionRowSetInput` is taken.
 */
export async function setConnectionRow(
	folderDir: string,
	operation: string,
	input: unknown,
): Promise<Result<ConnectionRow, ConnectionRowError>> {
	const { data: connection, error } = connectionOf(operation);
	if (error !== null) return Err(error);
	if (!isConnectionRowSetInput(input))
		return ConnectionRowError.InvalidInput({
			reason:
				'A connection save reads {"base": {"text", "issues"} | null, "fields": {"kind"?, "title"?, "model"?}} on stdin.',
		});
	const { base, fields } = input;
	const { error: directoryError } = await connectionsDirectory(folderDir, true);
	if (directoryError !== null) return Err(directoryError);
	const id = WHISPERING_CONNECTION_IDS[connection];
	return withConnections(folderDir, async (folder) => {
		const { data, error: saveError } = await folder.tables.connections.set(
			id,
			base,
			{ fields },
		);
		if (saveError !== null)
			return ConnectionRowError.SaveFailed({
				path: rowPath(connection),
				reason: saveError.message,
			});
		return Ok(answerOf(data.sent));
	});
}

/**
 * `epicenter whispering-connection read|set <transcription|text>`. `read`
 * answers `{"row": <row> | null}`; `set` reads `ConnectionRowSetInput` as
 * JSON on stdin and answers `{"row": <row as sent>}`. A refusal is
 * `{"error", "name"}` and exit 2; the file is as it was. A save a stop
 * signal interrupts finishes first (`finishBeforeExit`).
 */
export async function whisperingConnection(
	action: 'read' | 'set',
	operation: string,
	json: boolean,
): Promise<number> {
	const { folderDir } = resolveAppPaths();
	let answered: Result<ConnectionRow | null, ConnectionRowError>;
	if (action === 'read')
		answered = await readConnectionRow(folderDir, operation);
	else {
		let input: unknown;
		try {
			input = JSON.parse(await Bun.stdin.text());
		} catch {
			input = undefined;
		}
		answered = await finishBeforeExit(() =>
			setConnectionRow(folderDir, operation, input),
		);
	}
	const { data: row, error } = answered;
	if (error !== null) {
		if (json) writeJson({ error: error.message, name: error.name });
		else writeErr(error.message);
		return EXIT.unusable;
	}
	if (json) writeJson({ row });
	else writeOut(row === null ? 'no row' : row.text);
	return EXIT.ok;
}
