/**
 * The artifact read back: files in, one document out (ADR-0267, ADR-0268,
 * ADR-0295).
 *
 * The mirror of `renderArtifact`, and deliberately the same kind of thing: a
 * pure function over the public vocabulary, composed outside the store. It
 * rebuilds the database's one Yjs document from every row file, mints each
 * row with its body node, and hands the table's codec the body beneath the
 * frontmatter.
 *
 * Producing bytes rather than writing them is what keeps import honest about
 * where the destruction happens. Replacing a store means discarding its
 * durable record and letting it refill (ADR-0231's supersession), which is an
 * act on an address rather than on a live store, and belongs to whoever owns
 * the address. This function is the half that can be tested by reading its
 * output, and it holds no handle to anything a mistake could destroy.
 *
 * It fails closed, for the same reason the export does not: what comes out of
 * here replaces a store, so a file it could not read is a refusal rather than
 * a row quietly left out. `decode` runs once per row for every database
 * that will ever exist, because import is the only way a generation comes
 * into being (ADR-0293), which is rare in frequency and absolute in role.
 */

import * as Y from '@y/y';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import {
	compileData,
	type DataDefinition,
	type JsonObject,
	type ParsedTable,
} from '../definition/index.js';
import {
	createDatabaseDocument,
	createRow,
	kvRoot,
	tableRoot,
} from '../store/document.js';
import { parseRowFile } from './frontmatter.js';
import { parseRowPath } from './layout.js';

export const ImportError = defineErrors({
	/**
	 * The definition handed to the import could not be compiled, so there are
	 * no codecs to decode through. The export refuses the same way.
	 */
	MalformedDefinition: ({ reason }: { reason: string }) => ({
		message: `The data definition could not be compiled: ${reason}`,
		reason,
	}),
	/**
	 * A file in the artifact is not the file its path says it is. Fatal: an
	 * import that skipped it would replace a store with less than the
	 * person handed it.
	 */
	MalformedFile: ({ path, reason }: { path: string; reason: string }) => ({
		message: `'${path}' could not be read: ${reason}`,
		path,
		reason,
	}),
	/**
	 * A row file carries a body and its table declares no codec to read it
	 * with, so the body node has nowhere to go. Fatal rather than dropped: losing
	 * a body on import is the failure ADR-0268 exists to prevent, arriving
	 * from the other direction.
	 */
	UncodedBody: ({ table, rowId }: { table: string; rowId: string }) => ({
		message: `'${table}/${rowId}.md' has a body and table '${table}' declares no file codec to read it`,
		table,
		rowId,
	}),
	/** The table's own `decode` refused or threw on this file. */
	RowUnreadable: ({
		table,
		rowId,
		reason,
		cause,
	}: {
		table: string;
		rowId: string;
		reason: string;
		cause?: unknown;
	}) => ({
		message: `'${table}/${rowId}.md' could not be read into a row: ${reason}`,
		table,
		rowId,
		reason,
		cause,
	}),
});
export type ImportError = InferErrors<typeof ImportError>;

/**
 * Read a whole artifact into the one document that IS the database.
 *
 * One value, because there is one document (ADR-0295). What this used to
 * return was a list, because a row's body node was an independent document at a
 * derived address and a mint uploaded each one separately (ADR-0286); the
 * addresses are gone and so is the list.
 *
 * Paths are the addressing, as they are on the way out: `kv.json` is the kv
 * root, and every `<table>/<rowId>.md` is one row. A table the definition no
 * longer declares is imported anyway, rows and all, because the artifact is
 * the truth here and a declaration that stopped naming a table never meant its
 * data was gone (ADR-0240). Anything else in the map is not part of the
 * artifact and is left alone: a `.DS_Store` beside a person's folder is not a
 * reason to refuse their data.
 */
export function readArtifact(
	files: ReadonlyMap<string, string>,
	definition: DataDefinition,
): Result<Uint8Array, ImportError> {
	const parsed = compileData(definition);
	if (parsed.error !== null) {
		return ImportError.MalformedDefinition({ reason: parsed.error.message });
	}

	const database = createDatabaseDocument();
	try {
		const kv = files.get('kv.json');
		if (kv !== undefined) {
			const values = parseKv(kv);
			if (values === undefined) {
				return ImportError.MalformedFile({
					path: 'kv.json',
					reason: 'it is not a JSON object',
				});
			}
			database.transact(() => {
				const root = kvRoot(database);
				for (const [key, value] of Object.entries(values)) {
					root.setAttr(key as never, value as never);
				}
			});
		}

		for (const [path, text] of files) {
			const at = parseRowPath(path);
			if (at === undefined) continue;
			const file = parseRowFile(text);
			if (file === undefined) {
				return ImportError.MalformedFile({
					path,
					reason: 'it does not open with a frontmatter block',
				});
			}
			const table = parsed.data.tables.get(at.table);
			const { error } = admitRow({
				database,
				table,
				tableName: at.table,
				rowId: at.rowId,
				path,
				data: file.fields,
				body: file.body,
			});
			if (error !== null) return { data: null, error };
		}

		return Ok(new Uint8Array(Y.encodeStateAsUpdateV2(database)));
	} finally {
		database.destroy();
	}
}

/**
 * Put one file's row into the document.
 *
 * One transaction. The codec reads the body into a fresh body node, and
 * `createRow` integrates it beside the frontmatter values in the transaction
 * that mints the row.
 *
 * It used to be three writes: mint an empty row so the codec could be handed
 * ATTACHED types, read them back, let the codec fill them and return the
 * values, then write those. That existed because ADR-0296 measured a detached
 * `Y.Node` as unable to survive more than one write. The measurement does not
 * depend on detachment (the same `insert` pair throws on an attached type) and
 * does not hold for a Markdown conversion, which round trips through a
 * detached type to a byte-identical update. See ADR-0296's amendment.
 */
function admitRow({
	database,
	table,
	tableName,
	rowId,
	path,
	data,
	body,
}: {
	database: Y.Doc;
	table: ParsedTable | undefined;
	tableName: string;
	rowId: string;
	path: string;
	data: JsonObject;
	body: string;
}): Result<void, ImportError> {
	const root = tableRoot(database, tableName);
	const codec = table?.body;

	// The frontmatter IS the row, verbatim, including a key this declaration
	// does not name: the artifact is the truth here, and a release that stopped
	// naming a field never meant its data was gone (ADR-0240, ADR-0125). No
	// value is checked on the way in. Conformance is one decision, made once,
	// at read, for every row from every direction.
	const fields = { ...data };
	let node: Y.Node | undefined;

	if (codec === undefined && body !== '') {
		// A body with no codec to read it has nowhere to go, and dropping it is
		// the data loss this refuses. That includes intentional codec omission,
		// removed tables, and definitions that arrived as JSON.
		return ImportError.UncodedBody({ table: tableName, rowId });
	}
	if (codec !== undefined) {
		// The codec owns empty text too: it may reject it or build structure
		// that a bare empty node would omit.
		try {
			const read = codec.decode(body);
			if (read.error !== null) {
				return ImportError.RowUnreadable({
					table: tableName,
					rowId,
					reason: read.error.reason,
					cause: read.error.cause,
				});
			}
			node = read.data;
		} catch (cause) {
			return ImportError.RowUnreadable({
				table: tableName,
				rowId,
				reason: cause instanceof Error ? cause.message : String(cause),
				cause,
			});
		}
	}

	try {
		// One transaction: the row is minted, its values filled, and the node
		// the codec built integrated, together.
		database.transact(() => {
			createRow(root, rowId, fields, node);
		});
	} catch (cause) {
		return ImportError.MalformedFile({
			path,
			reason: cause instanceof Error ? cause.message : String(cause),
		});
	}
	return Ok(undefined);
}

function parseKv(text: string): JsonObject | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as JsonObject;
}
