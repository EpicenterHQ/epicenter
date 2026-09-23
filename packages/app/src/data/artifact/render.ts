/**
 * A row becomes one file (ADR-0268, ADR-0337, ADR-0296).
 *
 * This is the unit, and everything else is iteration: a whole render is the
 * same call in a loop. The artifact used to be assembled the other way around,
 * whole-store first,
 * because ADR-0267's layout put a row's fields and its document in two
 * separate trees correlated by coordinates. ADR-0268 collapsed that layout
 * into one file per row; this is the code catching up to it. A row's fields
 * and its body node go in the same file, so they are read in the same function
 * and never rejoined.
 *
 * **The platform owns the format; the table owns the body mapping** (ADR-0296).
 * What is here is the fence: the frontmatter block, the blank separator, and
 * the body beneath it. Stored fields go above the fence; the codec turns the
 * body node into the text below it.
 *
 * Composed on the opened data's public surface, so it is a follower and never
 * a store verb. It reads; nothing it returns can reach back in.
 */
import * as Y from '@y/y';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import {
	compileData,
	type DataDefinition,
	type ParsedDataDefinition,
} from '../definition/index.js';
import type { RowFile, StoredData } from '../store/store.js';
import { rowFile } from './frontmatter.js';
import { rowPath } from './layout.js';

export const RenderError = defineErrors({
	/**
	 * The definition handed here could not be compiled, so there are no codecs
	 * to serialize through. A programmer error surfaced as a value, because the
	 * caller is a person pressing a button.
	 */
	MalformedDefinition: ({ reason }: { reason: string }) => ({
		message: `The data definition could not be compiled: ${reason}`,
		reason,
	}),
	/**
	 * The table declares a body node and no codec to write it with, so this
	 * row's body has nowhere to go. Fatal for the row: a file that quietly
	 * lacks its body node feeds a restore that would delete that node everywhere.
	 *
	 * A table may omit its codec, but writing to its live node still works.
	 * Export must refuse that populated node to preserve its contents.
	 */
	UncodedRow: ({ table, rowId }: { table: string; rowId: string }) => ({
		message: `Table '${table}' declares a body node and no file codec to write '${rowId}' with`,
		table,
		rowId,
	}),
	/** The faithful row is malformed: it does not own the required body node. */
	MalformedRow: ({ table, rowId }: { table: string; rowId: string }) => ({
		message: `Row '${table}/${rowId}' has no live body node to write`,
		table,
		rowId,
	}),
	/**
	 * The table's own `encode` threw on this row. Contained rather than
	 * allowed to escape: a codec that throws is a case a person needs told,
	 * not a stack trace in the middle of their data being written to disk.
	 */
	BodyUnwritable: ({
		table,
		rowId,
		cause,
	}: {
		table: string;
		rowId: string;
		cause: unknown;
	}) => ({
		message: `The row at '${table}/${rowId}' could not be serialized`,
		table,
		rowId,
		cause,
	}),
});
export type RenderError = InferErrors<typeof RenderError>;

/**
 * What a render needs, and it is not a table handle.
 *
 * Two faithful reads, both on the store: everything, and one row. A handle
 * would be the wrong shape twice over, because it narrows to the declared
 * fields and refuses a row it cannot conform, and an export may do neither
 * (ADR-0267). This used to reach through `data.tables[table].stored/body`,
 * which meant the artifact layer's requirements sat on the type every
 * application holds.
 */
export type RenderableData = {
	/**
	 * The raw reads, declared as the slice this module needs rather than taken
	 * as a whole store.
	 *
	 * They are direct store methods because they return keys this release no
	 * longer declares and rows it cannot conform,
	 * which is the one thing an export may not narrow (ADR-0267). A table
	 * handle answers what an application can see; these answer what is there.
	 */
	stored(): StoredData;
	rowFile(table: string, rowId: string): RowFile | undefined;
};

/**
 * One row's file: the path it lives at, and what is in it.
 *
 * `contents` is `undefined` when the row is gone. Only a caller that names a
 * row it did not enumerate can see it: `renderArtifact` reads its ids from one
 * faithful snapshot, so every row it asks about is there. It answered the
 * mirror's deletion signal, which asked about ids a commit had removed, and
 * that caller is deleted (ADR-0337).
 */
export type RenderedRow = {
	readonly path: string;
	readonly contents: string | undefined;
};

/**
 * Render one row to its file.
 *
 * Synchronous work behind an async signature, because nothing here loads
 * anything any more: a row's body node is in the one document the store
 * already holds (ADR-0295). The signature stays a promise so the generator
 * below did not have to change shape around it.
 *
 * Everything value comes from the faithful read, never from `get` or `list`.
 * A table handle reads through the declaration and narrows to the fields it
 * names, so rendering through the lens would drop a value an older release
 * wrote: the row still conforms, so it is not reported as nonconforming, and
 * the value is simply gone from the file. That is the one thing an artifact
 * may not do. The artifact writes the stored payload as frontmatter and hands
 * only the body node to its codec.
 */
export async function renderRow(
	data: RenderableData,
	definition: ParsedDataDefinition,
	table: string,
	rowId: string,
): Promise<Result<RenderedRow, RenderError>> {
	const path = rowPath(table, rowId);
	const row = data.rowFile(table, rowId);
	if (row === undefined) {
		return Ok({ path, contents: undefined });
	}
	const { fields, body } = row;
	if (!(body instanceof Y.Node)) {
		return RenderError.MalformedRow({ table, rowId });
	}
	const node = body;
	const codec = definition.tables.get(table)?.body;
	if (codec === undefined) {
		// A table may declare no codec, and a row whose
		// node is empty has nothing that needed one: its file is its frontmatter,
		// which is the whole of what it is (ADR-0296). A node WITH body and no
		// codec has a body it cannot write, and writing the file without it is
		// the data loss this refuses.
		if (node.length > 0 || [...node.attrKeys()].length > 0) {
			return RenderError.UncodedRow({ table, rowId });
		}
		return Ok({ path, contents: rowFile(fields, undefined) });
	}
	if ([...node.attrKeys()].length > 0) {
		return RenderError.BodyUnwritable({
			table,
			rowId,
			cause: new Error('The body has root attributes this sequence codec cannot represent'),
		});
	}

	try {
		return Ok({
			path,
			contents: rowFile(fields, codec.encode(node)),
		});
	} catch (cause) {
		return RenderError.BodyUnwritable({ table, rowId, cause });
	}
}

/**
 * Every file a store renders to, one at a time.
 *
 * The loop over `renderRow`, plus `kv.json`, which is the one file that is not
 * a row: one object, no body, and nothing frontmatter would buy (ADR-0268).
 *
 * The whole store, because a `pull` is what makes a folder true as of one
 * instant (ADR-0337) and a partial one would leave a manifest describing a
 * folder that does not exist.
 *
 * Yielded rather than collected, because the one consumer writes each file as
 * it arrives and never wants the set. A caller that does want the set builds
 * one from this in a line; the reverse is not true, which is what makes this
 * the shape rather than a Map.
 *
 * Row ids come from the faithful read, so a table this declaration no longer
 * names is rendered too (ADR-0240).
 *
 * **It yields failures rather than stopping, and both callers fail closed.**
 * One row whose codec throws yields one `Err` and the loop continues, so the
 * caller sees every failure rather than the first. `pull` collects them and
 * refuses the whole checkout, and `readArtifact` refuses a read for the same
 * reason: a row silently absent from a folder is a deletion at the next push,
 * which is data deleted everywhere (ADR-0325).
 */
export async function* renderArtifact(
	data: RenderableData,
	definition: DataDefinition,
): AsyncGenerator<Result<RenderedRow, RenderError>> {
	const parsed = compileData(definition);
	if (parsed.error !== null) {
		yield RenderError.MalformedDefinition({ reason: parsed.error.message });
		return;
	}
	// One faithful read for the whole pass, so every file describes one instant.
	const state = data.stored();

	yield Ok({
		path: 'kv.json',
		contents: JSON.stringify(state.kv, null, 2),
	});
	for (const [table, rows] of state.tables) {
		for (const rowId of rows.keys()) {
			yield await renderRow(data, parsed.data, table, rowId);
		}
	}
}
