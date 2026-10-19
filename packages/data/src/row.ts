/** Rows retain their source and raw fields when the app's read schema fails. */
import type { TSchema as Schema, Static } from 'typebox';
import { Check, Errors } from 'typebox/value';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type CanonicalDocument,
	type CanonicalRefusal,
	formatRowSource,
	parseRowSource,
	sameValue,
} from './content/canonical.js';
import { frameRowText, joinRowText } from './content/markdown.js';

export type Issue = {
	kind: 'not-text' | 'frontmatter' | 'schema';
	message: string;
	path: readonly (string | number)[];
	line?: number;
};

/** `issues: null` narrows fields to the app's schema. Source is always exact. */
export type Row<TSchema extends Schema = Schema> = {
	id: string;
	text: string;
	body: string;
} & (
	| { fields: Static<TSchema>; issues: null }
	| { fields: Record<string, unknown>; issues: Issue[] }
);

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function readRow<const TSchema extends Schema>(
	id: string,
	content: string | Uint8Array,
	schema: TSchema,
): Row<TSchema> {
	let text: string;
	try {
		text = typeof content === 'string' ? content : decoder.decode(content);
	} catch {
		return unreadableRow(id, 'The file is not valid UTF-8');
	}
	const problem = textProblem(text);
	if (problem !== undefined) return unreadableRow(id, problem);
	const parsed = parseRowSource(text);
	if (parsed.error !== null)
		return {
			id,
			text,
			fields: {},
			body: text,
			issues: [
				{
					kind: 'frontmatter',
					message: parsed.error.reason,
					path: parsed.error.path,
					...(parsed.error.line === undefined
						? {}
						: { line: parsed.error.line }),
				},
			],
		};
	const { document, lineOf } = parsed.data;
	if (Check(schema, document.fields))
		return {
			id,
			text,
			...document,
			fields: document.fields as Static<TSchema>,
			issues: null,
		};
	const locations = sourceLocations(document.fields);
	const issues = Errors(schema, document.fields).map((error): Issue => {
		const path = locations.get(error.instancePath) ?? [];
		const [field] = path;
		const pointer = `/${path.slice(1).map(escapePointer).join('/')}`;
		const line =
			field === undefined
				? undefined
				: lineOf(String(field), path.length > 1 ? pointer : '');
		return {
			kind: 'schema',
			message: error.message,
			path,
			...(line === undefined ? {} : { line }),
		};
	});
	return { id, text, ...document, issues };
}

function unreadableRow(id: string, message: string) {
	return {
		id,
		text: '',
		body: '',
		fields: {},
		issues: [{ kind: 'not-text' as const, message, path: [] }],
	};
}

export type RowChange = {
	fields?: Record<string, unknown>;
	body?: string;
};

/** Build the draft's sent source. Schema validation never refuses a write. */
export function rowChange<TSchema extends Schema>(
	from: Row<TSchema> | null,
	change: RowChange,
): Result<{ text: string }, CanonicalRefusal> {
	if (from?.issues?.some((issue) => issue.kind === 'not-text'))
		return Err({
			reason: 'The source is not text; replace it through files',
			path: [],
		});
	const source = from?.text ?? '---\n---\n';
	const parsed = parseRowSource(source);
	if (parsed.error !== null) {
		if (change.fields !== undefined) return Err(parsed.error);
		if (change.body === undefined) return Ok({ text: source });
		const frame = frameRowText(source);
		const text =
			frame.kind === 'frontmatter'
				? appendBody(source, frame, change.body)
				: change.body;
		return checkedText(text);
	}
	const { document } = parsed.data;
	const body = change.body ?? document.body;
	if (change.fields === undefined) return replaceBody(source, body);
	const fields: Record<string, unknown> = { ...document.fields };
	for (const [key, value] of Object.entries(change.fields)) {
		if (value === undefined) delete fields[key];
		else
			Object.defineProperty(fields, key, {
				value,
				enumerable: true,
				writable: true,
				configurable: true,
			});
	}
	const formatted = formatRowSource(
		{ fields: fields as CanonicalDocument['fields'], body },
		parsed.data.keyOrder,
	);
	if (formatted.error !== null) return Err(formatted.error);
	if (sameValue(document.fields, formatted.data.document.fields))
		return replaceBody(source, body);
	return checkedText(formatted.data.text);
}

function replaceBody(source: string, body: string) {
	const frame = frameRowText(source);
	// Called only after the source has parsed successfully.
	if (frame.kind !== 'frontmatter')
		throw new Error('A parsed row has no frontmatter frame');
	return checkedText(appendBody(source, frame, body));
}

function appendBody(
	source: string,
	frame: Extract<ReturnType<typeof frameRowText>, { kind: 'frontmatter' }>,
	body: string,
) {
	return joinRowText(source.slice(0, frame.bodyStart), body);
}

function checkedText(text: string): Result<{ text: string }, CanonicalRefusal> {
	const problem = textProblem(text);
	return problem === undefined
		? Ok({ text })
		: Err({ reason: problem, path: [] });
}

function textProblem(text: string) {
	if (!text.isWellFormed()) return 'The text contains a lone surrogate';
	if (text.includes('\0')) return 'The text contains a NUL character';
	return undefined;
}

/** TypeBox 1.1 emits raw slash-joined keys. Ambiguous paths get no false location. */
function sourceLocations(fields: CanonicalDocument['fields']) {
	const locations = new Map<string, readonly (string | number)[] | null>();
	function visit(value: unknown, path: readonly (string | number)[]) {
		const key = path.length === 0 ? '' : `/${path.join('/')}`;
		locations.set(key, locations.has(key) ? null : path);
		if (value !== null && typeof value === 'object')
			for (const [key, child] of Object.entries(value))
				visit(child, [...path, Array.isArray(value) ? Number(key) : key]);
	}
	visit(fields, []);
	return locations;
}

function escapePointer(segment: string | number) {
	return String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
}
