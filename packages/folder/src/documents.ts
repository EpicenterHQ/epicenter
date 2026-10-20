/**
 * Markdown documents interpreted through an already open folder's files.
 * Paths identify documents, including Markdown at the root and in nested
 * directories. Missing frontmatter means empty fields; malformed frontmatter
 * stays visible with diagnostics. App table readers keep their stricter contract.
 */
import { Ok, type Result } from 'wellcrafted/result';
import { readDeclaredTables } from './declaration.js';
import type { Declaration } from './declaration-schema.js';
import type { FolderFiles, ReadError } from './folder.js';
import { type Document, readDocument } from './shared/document.js';
import { fileBytes } from './shared/observation.js';

export {
	type Document,
	documentChange,
	readDocument,
} from './shared/document.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

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
		const content = await fileBytes(read.data.content);
		const first = path.indexOf('/');
		const schema =
			first < 0 || path.indexOf('/', first + 1) !== -1
				? undefined
				: tables[path.slice(0, first)];
		documents.push(readDocument(path, content, schema));
	}
	return Ok({ documents, unreadable, tables, declarationProblem });
}
