/** Interpret the same saved files for the editor and the desktop SQL reader. */
import { Ok, type Result } from 'wellcrafted/result';
import type { TSchema } from 'typebox';
import { readDeclaredTables } from './declaration.js';
import type { Declaration } from './declaration-schema.js';
import type { FolderFiles, ReadError } from './folder.js';
import { type Document, readDocument } from './shared/document.js';

export {
	type Document,
	documentChange,
	readDocument,
} from './shared/document.js';

export type SavedFile = {
	readonly path: string;
	readonly data: string | Uint8Array | undefined;
	readonly readError: { readonly message: string } | null;
};
export type DocumentCache = WeakMap<
	SavedFile,
	{ schema: TSchema | undefined; document: Document }
>;
const declarationCache: WeakMap<
	SavedFile,
	ReturnType<typeof readDeclaredTables>
> = new WeakMap();
export type DocumentReading = {
	readonly documents: Document[];
	readonly unreadable: { path: string; message: string }[];
	readonly tables: Readonly<NonNullable<Declaration['tables']>>;
	readonly declarationProblem?: string;
};

/** Schemas apply only to direct Markdown children of a declared directory. */
export function documentsOf(
	files: readonly SavedFile[],
	cache?: DocumentCache,
): DocumentReading {
	let tables: Readonly<NonNullable<Declaration['tables']>> = {};
	let declarationProblem: string | undefined;
	const declaration = files.find((file) => file.path === 'epicenter.json');
	if (declaration?.readError)
		declarationProblem = declaration.readError.message;
	else if (declaration?.data instanceof Uint8Array)
		declarationProblem = 'epicenter.json is not UTF-8 text';
	else if (typeof declaration?.data === 'string') {
		let parsed = declarationCache.get(declaration);
		if (parsed === undefined) {
			parsed = readDeclaredTables(declaration.data);
			declarationCache.set(declaration, parsed);
		}
		if (parsed.error !== null) declarationProblem = parsed.error.reason;
		else tables = parsed.data ?? {};
	}
	const documents: Document[] = [];
	const unreadable: DocumentReading['unreadable'] = [];
	for (const file of files) {
		const { path, data, readError } = file;
		if (!path.endsWith('.md')) continue;
		if (readError && data === undefined) {
			unreadable.push({ path, message: readError.message });
			continue;
		}
		if (data === undefined) continue;
		const first = path.indexOf('/');
		const schema =
			first < 0 || path.indexOf('/', first + 1) !== -1
				? undefined
				: tables[path.slice(0, first)];
		const previous = cache?.get(file);
		if (previous !== undefined && previous.schema === schema) {
			documents.push(previous.document);
			continue;
		}
		const document = readDocument(path, data, schema);
		cache?.set(file, { schema, document });
		documents.push(document);
	}
	return { documents, unreadable, tables, declarationProblem };
}

/** Adapter for callers still using the old FolderFiles API. */
export async function readDocuments(
	files: Pick<FolderFiles, 'list' | 'read'>,
): Promise<Result<DocumentReading, ReadError>> {
	const listed = await files.list();
	if (listed.error !== null) return listed;
	const saved: SavedFile[] = [];
	for (const path of new Set(['epicenter.json', ...listed.data])) {
		const read = await files.read(path);
		if (read.error !== null) {
			saved.push({ path, data: undefined, readError: read.error });
			continue;
		}
		if (read.data === undefined) continue;
		const bytes = new Uint8Array(await read.data.content.arrayBuffer());
		saved.push({ path, data: decode(bytes), readError: null });
	}
	return Ok(documentsOf(saved));
}

function decode(bytes: Uint8Array): string | Uint8Array {
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	} catch {
		return bytes;
	}
}
