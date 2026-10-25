/**
 * Whispering reads and saves two connection rows in Epicenter's records
 * folder, the fixed `<folderDir>/so.epicenter` (`epicenterDirectory`). The
 * operation names a row. Reads create nothing; a save creates the folder when
 * it is missing. No configuration is read or written. Row writes publish
 * assignments to the current source.
 */

import {
	type ConnectionRow,
	type ConnectionRowIssue,
	connectionsTables,
	isConnectionRowSetInput,
	WHISPERING_CONNECTION_IDS,
	type WhisperingConnection,
} from '@epicenter/ai/connection-table';
import { type Folder, openFolder } from '@epicenter/folder/next/bun';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type AppPaths, resolveAppPaths } from './app-paths.js';
import { epicenterDirectory } from './folders.js';
import { EXIT, writeErr, writeJson, writeOut } from './output.js';

export const ConnectionRowError = defineErrors({
	/** The operation or the input is not one this command takes. */
	InvalidInput: ({ reason }: { reason: string }) => ({
		message: reason,
		reason,
	}),
	/** Epicenter's records folder cannot be used. */
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
	/** The save was refused or its publication could not be confirmed. */
	SaveFailed: ({ path, reason }: { path: string; reason: string }) => ({
		message: `${path} could not be saved: ${reason}`,
		path,
		reason,
	}),
});
export type ConnectionRowError = InferErrors<typeof ConnectionRowError>;

function connectionOf(
	operation: string,
): Result<WhisperingConnection, ConnectionRowError> {
	if (Object.hasOwn(WHISPERING_CONNECTION_IDS, operation))
		// SAFETY: the own-key check narrows operation to the fixed connection names.
		return Ok(operation as WhisperingConnection);
	return ConnectionRowError.InvalidInput({
		reason: `epicenter whispering-connection takes transcription or text, not '${operation}'`,
	});
}

/** Resolve the records folder, creating it only for a save. */
async function connectionsDirectory(paths: AppPaths, create: boolean) {
	try {
		return Ok(await epicenterDirectory(paths, create));
	} catch (cause) {
		return ConnectionRowError.FolderUnusable({
			reason: extractErrorMessage(cause),
		});
	}
}

/** Open the records directory with its `connections` table, run `work`, and close it. */
async function withConnections<T>(
	directory: string,
	work: (
		folder: Folder<typeof connectionsTables>,
	) => Promise<Result<T, ConnectionRowError>>,
): Promise<Result<T, ConnectionRowError>> {
	const opened = await openFolder({
		directory,
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

/** A stored row as the command answers it: exact source, issues, and schema fields. */
function answerOf(
	folder: Folder<typeof connectionsTables>,
	id: string,
	path: string,
): Result<ConnectionRow | null, ConnectionRowError> {
	const row = folder.tables.connections.row(id);
	if (row === undefined) return Ok(null);
	const issue = row.issues?.find((issue) => issue.kind === 'unreadable');
	if (issue !== undefined)
		return ConnectionRowError.ReadFailed({ path, reason: issue.message });
	const data = folder.file(row.path)?.data;
	if (data === undefined)
		return ConnectionRowError.ReadFailed({
			path,
			reason: 'The row has no readable source.',
		});
	const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
	if (row.issues !== null)
		return Ok({
			text,
			issues: row.issues.filter(
				(issue): issue is ConnectionRowIssue => issue.kind !== 'unreadable',
			),
			fields: null,
		});
	const { kind, title, model } = row.fields;
	return Ok({ text, issues: null, fields: { kind, title, model } });
}

/**
 * The row `operation` names in the records folder, or `null` when no row
 * exists, including when the folder is not there. Reading creates nothing.
 */
export async function readConnectionRow(
	paths: AppPaths,
	operation: string,
): Promise<Result<ConnectionRow | null, ConnectionRowError>> {
	const { data: connection, error } = connectionOf(operation);
	if (error !== null) return Err(error);
	const { data: directory, error: directoryError } = await connectionsDirectory(
		paths,
		false,
	);
	if (directoryError !== null) return Err(directoryError);
	if (directory === undefined) return Ok(null);
	const id = WHISPERING_CONNECTION_IDS[connection];
	return withConnections(directory, async (folder) =>
		answerOf(folder, id, `${directory}/connections/${id}.md`),
	);
}

/**
 * Save `input`'s field assignments to the row `operation` names and answer
 * the row as sent. `input` is untrusted JSON: only
 * `ConnectionRowSetInput` is taken.
 */
export async function setConnectionRow(
	paths: AppPaths,
	operation: string,
	input: unknown,
): Promise<Result<ConnectionRow, ConnectionRowError>> {
	const { data: connection, error } = connectionOf(operation);
	if (error !== null) return Err(error);
	if (!isConnectionRowSetInput(input))
		return ConnectionRowError.InvalidInput({
			reason:
				'A connection save reads {"fields": {"kind"?, "title"?, "model"?}} on stdin.',
		});
	const { fields } = input;
	const { data: directory, error: directoryError } = await connectionsDirectory(
		paths,
		true,
	);
	if (directoryError !== null) return Err(directoryError);
	if (directory === undefined)
		return ConnectionRowError.FolderUnusable({
			reason: 'The Epicenter data folder is not there.',
		});
	const id = WHISPERING_CONNECTION_IDS[connection];
	return withConnections(directory, async (folder) => {
		const path = `${directory}/connections/${id}.md`;
		const existing = folder.tables.connections.row(id);
		let saved: Awaited<ReturnType<typeof folder.tables.connections.create>>;
		if (existing === undefined) {
			const { kind, title, model } = fields;
			if (kind === undefined || title === undefined || model === undefined)
				return ConnectionRowError.InvalidInput({
					reason: 'a new connection row needs kind, title, and model',
				});
			saved = await folder.tables.connections.create(id, {
				fields: { kind, title, model },
			});
		} else {
			saved = await folder.tables.connections.update(id, { fields });
		}
		if (saved.error !== null)
			return ConnectionRowError.SaveFailed({
				path,
				reason: saved.error.message,
			});
		const answered = answerOf(folder, id, path);
		if (answered.error !== null) return Err(answered.error);
		if (answered.data === null)
			return ConnectionRowError.ReadFailed({
				path,
				reason: 'The saved row is missing.',
			});
		return Ok(answered.data);
	});
}

/**
 * `epicenter whispering-connection read|set <transcription|text>`. `read`
 * answers `{"row": <row> | null}`; `set` reads `ConnectionRowSetInput` as
 * JSON on stdin and answers `{"row": <landed row>}`. A refusal is
 * `{"error", "name"}` and exit 2. The command awaits
 * its save before answering. A stop signal may interrupt ordinary work.
 */
export async function whisperingConnection(
	action: 'read' | 'set',
	operation: string,
	json: boolean,
): Promise<number> {
	const paths = resolveAppPaths();
	let answered: Result<ConnectionRow | null, ConnectionRowError>;
	if (action === 'read') answered = await readConnectionRow(paths, operation);
	else {
		let input: unknown;
		try {
			input = JSON.parse(await Bun.stdin.text());
		} catch {
			input = undefined;
		}
		answered = await setConnectionRow(paths, operation, input);
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
