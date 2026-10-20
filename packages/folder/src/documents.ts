/**
 * Markdown documents interpreted through an already open folder's files.
 * Paths identify documents, including Markdown at the root and in nested
 * directories. Missing frontmatter means empty fields; malformed frontmatter
 * stays visible with diagnostics. App table readers keep their stricter contract.
 */
import { type TSchema, Type } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { readDeclaredTables } from './declaration.js';
import type { Declaration } from './declaration-schema.js';
import type { FolderFiles, ReadError, Row, RowChange } from './folder.js';
import { frameRowText } from './shared/content/markdown.js';
import { readRow, rowChange } from './shared/row.js';

const anyFields = Type.Record(Type.String(), Type.Unknown());
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type Document = Omit<Row, 'fields'> & {
	readonly fields: Record<string, unknown>;
	readonly path: string;
	readonly directory: string;
	readonly stem: string;
	readonly content: Uint8Array;
};

/** Read one document without discarding its source when validation fails. */
export function readDocument(
	path: string,
	content: Uint8Array,
	schema: TSchema = anyFields,
): Document {
	let row = interpretedRow(path, content, schema);
	try {
		const text = decoder.decode(content);
		if (
			!text.includes('\0') &&
			text.isWellFormed() &&
			frameRowText(text).kind === 'missing'
		) {
			row = {
				...interpretedRow(path, `---\n---\n${text}`, schema),
				text,
				body: text,
			};
		}
	} catch {
		// readRow already reports the exact decoding failure.
	}
	const slash = path.lastIndexOf('/');
	return {
		...row,
		fields: row.fields as Record<string, unknown>,
		path,
		directory: slash < 0 ? '' : path.slice(0, slash),
		stem: path.slice(slash + 1, -3),
		content: new Uint8Array(content),
	};
}

/** Validator failures remain a document issue beside repairable source. */
function interpretedRow(
	path: string,
	content: string | Uint8Array,
	schema: TSchema,
): Row {
	try {
		return readRow(path, content, schema);
	} catch (cause) {
		const raw = readRow(path, content, anyFields);
		return {
			...raw,
			issues: [
				...(raw.issues ?? []),
				{
					kind: 'schema',
					path: [],
					message: `Schema validation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				},
			],
		};
	}
}

/** A field edit may introduce frontmatter; a body edit alone need not. */
export function documentChange(
	from: Pick<Row, 'text' | 'issues'>,
	change: RowChange,
) {
	if (frameRowText(from.text).kind !== 'missing')
		return rowChange(from, change);
	if (change.fields === undefined) return rowChange(from, change);
	const bom = from.text.startsWith('\uFEFF') ? '\uFEFF' : '';
	const newline =
		from.text.includes('\r\n') &&
		!from.text.replaceAll('\r\n', '').includes('\n')
			? '\r\n'
			: '\n';
	return rowChange(
		{
			...from,
			text: `${bom}---${newline}---${newline}${from.text.slice(bom.length)}`,
		},
		change,
	);
}

export type DocumentReading = {
	readonly documents: Document[];
	readonly unreadable: { path: string; message: string }[];
	readonly tables: Readonly<NonNullable<Declaration['tables']>>;
	readonly declarationProblem?: string;
};

/**
 * Read saved Markdown once. Table schemas interpret only direct Markdown
 * children, matching app and CLI table membership. Unreadable files are named separately; malformed readable
 * documents remain in the reading for repair and raw SQL inspection.
 */
export async function readDocuments(
	files: Pick<FolderFiles, 'list' | 'read'>,
): Promise<Result<DocumentReading, ReadError>> {
	let tables: Readonly<NonNullable<Declaration['tables']>> = {};
	let declarationProblem: string | undefined;
	const declaration = await files.read('epicenter.json');
	if (declaration.error !== null)
		declarationProblem = declaration.error.message;
	else if (declaration.data !== undefined) {
		try {
			const source = decoder.decode(
				await declaration.data.content.arrayBuffer(),
			);
			const parsed = readDeclaredTables(source);
			if (parsed.error !== null) declarationProblem = parsed.error.reason;
			else tables = parsed.data ?? {};
		} catch {
			declarationProblem = 'epicenter.json is not UTF-8 text';
		}
	}
	const listed = await files.list();
	if (listed.error !== null) return listed;
	const documents: Document[] = [];
	const unreadable: DocumentReading['unreadable'] = [];
	for (const path of listed.data) {
		if (!path.endsWith('.md')) continue;
		const read = await files.read(path);
		if (read.error !== null) {
			unreadable.push({ path, message: read.error.message });
			continue;
		}
		if (read.data === undefined) {
			unreadable.push({
				path,
				message: 'The listed file is missing or is not a regular file',
			});
			continue;
		}
		const content = new Uint8Array(await read.data.content.arrayBuffer());
		const first = path.indexOf('/');
		const schema =
			first < 0 || path.indexOf('/', first + 1) !== -1
				? undefined
				: tables[path.slice(0, first)];
		documents.push(readDocument(path, content, schema));
	}
	return Ok({ documents, unreadable, tables, declarationProblem });
}
