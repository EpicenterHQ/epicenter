/**
 * Content-only three-way merge (ADR-0622). Independent fields and line regions
 * survive; the change wins competing units. No schema or storage participates.
 */
import {
	type CanonicalDocument,
	formatRowSource,
	parseRowSource,
	sameValue,
} from './content/canonical.js';
import { frameRowText, joinRowText } from './content/markdown.js';
import { type CompetingRegion, mergeLines } from './content/merge-lines.js';
import { rowChange } from './row.js';

export type FileContent = string | Uint8Array;

/** Units of current content replaced by a competing change, never the lost contents. */
export type Overridden =
	| { kind: 'field'; field: string }
	| { kind: 'lines'; part: 'body' | 'text'; line: number; count: number }
	| { kind: 'file' };

export type FileVersions = {
	base: FileContent | null;
	current: FileContent | null;
	change: FileContent | null;
};

type Merged = {
	content: FileContent | null;
	overridden: readonly Overridden[];
};

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Byte equality across text and binary representations; null means absent. */
export function sameContent(
	left: FileContent | null,
	right: FileContent | null,
) {
	if (left === null || right === null) return left === right;
	if (typeof left === 'string' && typeof right === 'string')
		return left === right;
	const a = typeof left === 'string' ? encoder.encode(left) : left;
	const b = typeof right === 'string' ? encoder.encode(right) : right;
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function textOf(content: FileContent | null): string | null | undefined {
	if (content === null) return null;
	if (typeof content === 'string')
		return content.includes('\0') ? undefined : content;
	if (content.includes(0)) return undefined;
	try {
		return decoder.decode(content);
	} catch {
		return undefined;
	}
}

const linesOf = (
	part: 'body' | 'text',
	region: CompetingRegion,
): Overridden => ({
	kind: 'lines',
	part,
	line: region.line + 1,
	count: region.count,
});

/** Merge files using named roles. Unchanged content retains its exact representation. */
export async function merge(
	path: string,
	{ base, current, change }: FileVersions,
): Promise<Merged> {
	if (sameContent(current, change) || sameContent(change, base))
		return { content: current, overridden: [] };
	if (sameContent(current, base)) return { content: change, overridden: [] };
	// Both sides changed. An unseen deletion cannot erase a concurrent edit.
	if (current === null || change === null)
		return { content: change ?? current, overridden: [{ kind: 'file' }] };
	const [b, c, n] = [textOf(base), textOf(current), textOf(change)];
	if (
		b === undefined ||
		c === undefined ||
		n === undefined ||
		c === null ||
		n === null
	)
		return { content: change, overridden: [{ kind: 'file' }] };
	if (
		path.endsWith('.md') &&
		[b, c, n].some(
			(text) => text !== null && frameRowText(text).kind === 'frontmatter',
		)
	) {
		const markdown = await mergeMarkdown(b, c, n);
		if (markdown !== undefined)
			return preserveRepresentation(markdown, current, change);
		return preserveRepresentation(
			await mergeUnparsedMarkdown(b, c, n),
			current,
			change,
		);
	}
	const text = await mergeLines({ base: b ?? '', current: c, change: n });
	return preserveRepresentation(
		{
			content: text.content,
			overridden: text.regions.map((region) => linesOf('text', region)),
		},
		current,
		change,
	);
}

function preserveRepresentation(
	result: Merged,
	current: FileContent,
	change: FileContent,
): Merged {
	if (sameContent(result.content, current))
		return { ...result, content: current };
	if (sameContent(result.content, change))
		return { ...result, content: change };
	return result;
}

type Framed = CanonicalDocument & {
	text: string;
	head: string;
	keyOrder: readonly string[];
};
const lineFeeds = (text: string) => text.replace(/\r\n/g, '\n');

function framed(text: string): Framed | undefined {
	const { data, error } = parseRowSource(text);
	if (error !== null) return undefined;
	const { fields, body } = data.document;
	return {
		fields,
		body: lineFeeds(body),
		head: text.slice(0, text.length - body.length),
		text,
		keyOrder: data.keyOrder,
	};
}

/** Keep a side's presentation, including independent comment edits, when its values stand. */
async function keptHead(
	base: Framed | null,
	current: Framed,
	change: Framed,
	kept: Framed,
) {
	if (
		base === null ||
		current.head === change.head ||
		current.head === base.head ||
		change.head === base.head
	)
		return { head: kept.head, overridden: [] as Overridden[] };
	const merged = await mergeLines(
		{ base: base.head, current: current.head, change: change.head },
		{ union: false },
	);
	if (merged.regions.length === 0) {
		const read = framed(merged.content);
		if (read !== undefined && sameValue(read.fields, kept.fields))
			return { head: merged.content, overridden: [] as Overridden[] };
	}
	// Field conflicts already name semantic changes. Report a dropped current
	// presentation-only edit separately, without letting it restore an old value.
	if (kept === current || !sameValue(current.fields, base.fields))
		return { head: kept.head, overridden: [] as Overridden[] };
	return {
		head: kept.head,
		overridden:
			merged.regions.length === 0
				? [
						{
							kind: 'lines',
							part: 'text',
							line: 1,
							count: kept.head.split('\n').length - 1,
						} satisfies Overridden,
					]
				: merged.regions.map((region) => linesOf('text', region)),
	};
}

async function mergeMarkdown(
	base: string | null,
	current: string,
	change: string,
): Promise<Merged | undefined> {
	const [b, c, n] = [
		base === null ? null : framed(base),
		framed(current),
		framed(change),
	];
	if (b === undefined || c === undefined || n === undefined) return undefined;
	const fields: Record<string, unknown> = {};
	const overridden: Overridden[] = [];
	const value = (row: Framed | null, key: string) =>
		row !== null && Object.hasOwn(row.fields, key)
			? row.fields[key]
			: undefined;
	for (const key of new Set([
		...Object.keys(c.fields),
		...Object.keys(n.fields),
		...Object.keys(b?.fields ?? {}),
	])) {
		const [before, now, next] = [value(b, key), value(c, key), value(n, key)];
		let chosen: unknown;
		if (sameValue(now, next) || sameValue(next, before)) chosen = now;
		else if (sameValue(now, before)) chosen = next;
		else {
			chosen = next;
			overridden.push({ kind: 'field', field: key });
		}
		if (chosen !== undefined)
			Object.defineProperty(fields, key, {
				value: chosen,
				enumerable: true,
				configurable: true,
				writable: true,
			});
	}
	const body = await mergeLines({
		base: b?.body ?? '',
		current: c.body,
		change: n.body,
	});
	overridden.push(...body.regions.map((region) => linesOf('body', region)));
	const kept = [c, n].find((side) => sameValue(fields, side.fields));
	if (kept !== undefined) {
		const head = await keptHead(b, c, n, kept);
		const units = [...head.overridden, ...overridden];
		if (head.head === kept.head && body.content === kept.body)
			return { content: kept.text, overridden: units };
		return {
			content: joinRowText(
				head.head,
				head.head.includes('\r\n')
					? body.content.replaceAll('\n', '\r\n')
					: body.content,
			),
			overridden: units,
		};
	}
	// Patch the merged values into the current source so its comments and
	// unrecognized presentation survive independent field edits.
	const patch: Record<string, unknown> = {};
	for (const key of new Set([
		...Object.keys(c.fields),
		...Object.keys(fields),
	])) {
		if (sameValue(c.fields[key], fields[key])) continue;
		Object.defineProperty(patch, key, {
			value: fields[key],
			enumerable: true,
		});
	}
	const edited = rowChange(
		{ text: c.text, issues: null },
		{ fields: patch, body: body.content },
	);
	if (edited.error === null) return { content: edited.data.text, overridden };
	// Existing keys keep current's order. All newly introduced keys sort together.
	const { data, error } = formatRowSource(
		{ fields, body: body.content },
		c.keyOrder,
	);
	return error === null ? { content: data.text, overridden } : undefined;
}

/** Invalid frontmatter stays repairable text; body insertions still union. */
async function mergeUnparsedMarkdown(
	base: string | null,
	current: string,
	change: string,
): Promise<Merged> {
	const split = (text: string) => {
		const frame = frameRowText(text);
		return frame.kind === 'frontmatter'
			? {
					head: text.slice(0, frame.bodyStart),
					body: text.slice(frame.bodyStart),
				}
			: undefined;
	};
	const [b, c, n] = [
		base === null ? { head: '', body: '' } : split(base),
		split(current),
		split(change),
	];
	if (b === undefined || c === undefined || n === undefined) {
		const text = await mergeLines(
			{ base: base ?? '', current, change },
			{ union: false },
		);
		return {
			content: text.content,
			overridden: text.regions.map((region) => linesOf('text', region)),
		};
	}
	const head = await mergeLines(
		{ base: b.head, current: c.head, change: n.head },
		{ union: false },
	);
	const body = await mergeLines({
		base: b.body,
		current: c.body,
		change: n.body,
	});
	return {
		content: joinRowText(head.content, body.content),
		overridden: [
			...head.regions.map((region) => linesOf('text', region)),
			...body.regions.map((region) => linesOf('body', region)),
		],
	};
}
