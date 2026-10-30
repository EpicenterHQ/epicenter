/** Pure Markdown reading and changing under one framing rule. */

import {
	type CanonicalDocument,
	type CanonicalRefusal,
	formatRowSource,
	frameRowText,
	joinRowText,
	parseRowSource,
	sameValue,
} from '@epicenter/definition/note';
import type { TSchema as Schema, Static } from 'typebox';
import { Check, Errors } from 'typebox/value';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { parseDocument } from 'yaml';

export type Issue = {
	kind: 'not-text' | 'frontmatter' | 'schema';
	message: string;
	path: readonly (string | number)[];
	line?: number;
};

/** Parsed values retain raw fields on schema failure; a broken header has no fields. */
export type MarkdownValue<TSchema extends Schema = Schema> = {
	text: string;
} & (
	| { body: string; fields: Static<TSchema>; issues: null }
	| { body: string; fields: Record<string, unknown>; issues: readonly Issue[] }
	| { body: string | undefined; fields: undefined; issues: readonly Issue[] }
);

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function readMarkdown<const TSchema extends Schema>(
	content: string | Uint8Array,
	schema: TSchema,
): MarkdownValue<TSchema> {
	let text: string;
	try {
		text = typeof content === 'string' ? content : decoder.decode(content);
	} catch {
		return unreadableMarkdown<TSchema>('', 'The file is not valid UTF-8');
	}
	const problem = textProblem(text);
	if (problem !== undefined) return unreadableMarkdown<TSchema>(text, problem);
	const parsed = parseRowSource(text);
	if (parsed.error !== null) {
		const frame = frameRowText(text);
		return {
			text,
			fields: undefined,
			body:
				frame.kind === 'frontmatter' ? text.slice(frame.bodyStart) : undefined,
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
	}
	const { document, lineOf } = parsed.data;
	try {
		if (Check(schema, document.fields))
			return {
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
		return { text, ...document, issues };
	} catch (cause) {
		return {
			text,
			...document,
			issues: [
				{
					kind: 'schema',
					path: [],
					message: `Schema validation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				},
			],
		};
	}
}

function unreadableMarkdown<TSchema extends Schema>(
	text: string,
	message: string,
): MarkdownValue<TSchema> {
	return {
		text,
		body: undefined,
		fields: undefined,
		issues: [{ kind: 'not-text' as const, message, path: [] }],
	};
}

export type MarkdownChange = {
	fields?: Record<string, unknown>;
	body?: string;
};

/** Change parseable source; schema validation never refuses a write. */
export function changeMarkdown(
	from: Pick<MarkdownValue, 'text' | 'issues'> | null,
	change: MarkdownChange,
): Result<{ text: string }, CanonicalRefusal> {
	if (from?.issues?.some((issue) => issue.kind === 'not-text'))
		return Err({
			reason: 'The source is not text; replace it through files',
			path: [],
		});
	const source = from?.text ?? '---\n---\n';
	if (frameRowText(source).kind === 'missing' && change.fields !== undefined) {
		if (Object.values(change.fields).every((value) => value === undefined))
			return changeMarkdown(from, { body: change.body });
		const bom = source.startsWith('﻿') ? '﻿' : '';
		const newline =
			source.includes('\r\n') && !source.replaceAll('\r\n', '').includes('\n')
				? '\r\n'
				: '\n';
		return changeMarkdown(
			{
				text: `${bom}---${newline}---${newline}${source.slice(bom.length)}`,
				issues: from?.issues ?? null,
			},
			change,
		);
	}
	const parsed = parseRowSource(source);
	if (parsed.error !== null) return Err(parsed.error);
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
	const formatted = formatRowSource({ fields, body }, parsed.data.keyOrder);
	if (formatted.error !== null) return Err(formatted.error);
	if (sameValue(document.fields, formatted.data.document.fields))
		return replaceBody(source, body);
	const frame = frameRowText(source);
	if (frame.kind !== 'frontmatter')
		throw new Error('A parsed row has no frontmatter frame');
	const yaml = parseDocument(source.slice(frame.yamlStart, frame.yamlEnd), {
		prettyErrors: false,
		uniqueKeys: true,
		version: '1.2',
		intAsBigInt: true,
	});
	for (const key of parsed.data.keyOrder) {
		if (sameValue(document.fields[key], fields[key])) continue;
		if (Object.hasOwn(fields, key)) yaml.set(key, fields[key]);
		else yaml.delete(key);
	}
	for (const key of Object.keys(fields).sort()) {
		if (Object.hasOwn(document.fields, key)) continue;
		yaml.set(key, fields[key]);
	}
	const header = yaml.toString().replaceAll('\n', frame.newline);
	const changed = joinRowText(
		source.slice(0, frame.yamlStart) +
			header +
			source.slice(frame.yamlEnd, frame.bodyStart),
		body,
	);
	const reread = parseRowSource(changed);
	if (
		reread.error !== null ||
		!sameValue(reread.data.document.fields, formatted.data.document.fields) ||
		reread.data.document.body !== body
	)
		return Err({
			reason: 'The edited source does not read back as the change',
			path: [],
		});
	return checkedText(changed);
}

function replaceBody(source: string, body: string) {
	const frame = frameRowText(source);
	if (frame.kind === 'missing') {
		const text = frame.bom + body;
		if (frameRowText(text).kind !== 'missing') {
			const newline = body.includes('\r\n') ? '\r\n' : '\n';
			return checkedText(`${frame.bom}---${newline}---${newline}${body}`);
		}
		return checkedText(text);
	}
	// Called only after the source has parsed successfully.
	if (frame.kind !== 'frontmatter')
		throw new Error('A parsed row has no frontmatter frame');
	return checkedText(joinRowText(source.slice(0, frame.bodyStart), body));
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
