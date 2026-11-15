/**
 * A collection's `path`: where its files are, as a template. One template
 * says three things at once:
 *
 * - which files belong: `data/words/{word}.md` holds every `.md` file in `data/words/`;
 * - a record's address: its path, such as `data/words/你好.md`, from which a read
 *   gives each placeholder's value (`word: '你好'`);
 * - where `add` writes: each placeholder is a value `add` takes, except
 *   `{time}`, which `add` makes from the time.
 *
 * A template with no placeholder is one file (`data/settings.md`). A collection has
 * one template, so each of the three has one answer; files in a second layout
 * are a second collection.
 */
import { customAlphabet } from 'nanoid';
import { isLocalPath } from './context.ts';

/** The names inside a template's braces: `Placeholders<'notes/{year}/{time}.md'>` is `'year' | 'time'`. */
export type Placeholders<P extends string> =
	P extends `${string}{${infer Name}}${infer Rest}`
		? Name | Placeholders<Rest>
		: never;

/** Whether a collection is one file: its `path` has no placeholder. */
export type IsSingle<P extends string> = [Placeholders<P>] extends [never]
	? string extends P
		? false
		: true
	: false;

/** The placeholder `add` fills in itself. */
export const TIME = 'time';

const PLACEHOLDER = /\{([a-z][A-Za-z0-9]*)\}/g;
const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/**
 * How many bytes a placeholder's value may take. A file name holds 255, and
 * `folder` writes beside a file under its name and up to 47 bytes more.
 */
const MAX_SEGMENT_BYTES = 200;

/**
 * A value as it names a file: NFC, so one word typed two ways names one file;
 * trimmed; and each run of whitespace, a line break included, one space.
 */
function asSegment(value: string): string {
	return value.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** A placeholder's value names one path segment: no `/` or `\`, and no leading `.`. */
function isSegmentValue(value: string): boolean {
	return value !== '' && !/[/\\]/.test(value) && !value.startsWith('.');
}

/** One template, read: its placeholders, how to match a path, and how to fill it. */
export type Template = {
	readonly text: string;
	readonly placeholders: readonly string[];
	/** The directory to list for its files: the literal part before the first placeholder, up to its last `/`. */
	readonly dir: string;
	/**
	 * The placeholder values when `path` is one of its files, else
	 * `undefined`. A template that is not `.local` never matches a `.local`
	 * path, so a value such as `token.local` never makes a record of a file
	 * that stays on this computer.
	 */
	match(path: string): Record<string, string> | undefined;
	/** The path for these values; throws when they make a `.local` path of a template that is not one. */
	fill(values: Record<string, string>): string;
};

/**
 * What is wrong with `text` as a template, or `undefined`: it must be a
 * relative `.md` path inside the folder, with no `.` or `..` part, no part
 * starting with `.`, and at most one placeholder in any part.
 */
export function templateProblem(text: string): string | undefined {
	if (!text.endsWith('.md')) return `${text} is not a .md path`;
	const parts = text.split('/');
	if (text.startsWith('/') || text.includes('\\') || parts.includes(''))
		return `${text} is not a relative path`;
	if (parts.some((part) => part.startsWith('.')))
		return `${text} has a part that starts with "."`;
	for (const part of parts) {
		const found = part.match(PLACEHOLDER) ?? [];
		if (found.length > 1)
			return `${text} has two placeholders in "${part}", so a name could not be split between them`;
		if (part.replace(PLACEHOLDER, '').match(/[{}]/))
			return `${text} has a brace that is not a placeholder such as {word}`;
	}
	const names = [...text.matchAll(PLACEHOLDER)].map(([, name]) => name);
	const twice = names.find((name, at) => names.indexOf(name) !== at);
	if (twice !== undefined) return `${text} has {${twice}} twice`;
	return undefined;
}

/** `text`, read as a template; check it with `templateProblem` first. */
export function template(text: string): Template {
	const placeholders = [...text.matchAll(PLACEHOLDER)].map(
		([, name]) => name as string,
	);
	const local = isLocalPath(text);
	const firstBrace = text.indexOf('{');
	const literal = firstBrace < 0 ? text : text.slice(0, firstBrace);
	const pattern = new RegExp(
		`^${text
			.split(PLACEHOLDER)
			.map((piece, at) => (at % 2 ? '([^/]+)' : piece.replace(ESCAPE, '\\$&')))
			.join('')}$`,
	);
	return {
		text,
		placeholders,
		dir: literal.slice(0, literal.lastIndexOf('/') + 1),
		match(path) {
			const found = pattern.exec(path);
			if (!found || (!local && isLocalPath(path))) return undefined;
			const values: Record<string, string> = {};
			for (const [at, name] of placeholders.entries()) {
				const value = found[at + 1] as string;
				if (!isSegmentValue(value)) return undefined;
				values[name] = value;
			}
			return values;
		},
		fill(values) {
			const path = text.replace(PLACEHOLDER, (_, name: string) => {
				const given = name === TIME ? (values[name] ?? timeId()) : values[name];
				if (given === undefined) throw new Error(`{${name}} is needed`);
				const value = asSegment(given);
				if (!isSegmentValue(value))
					throw new Error(
						`${JSON.stringify(given)} cannot name a file: it is empty, has / or \\, or starts with .`,
					);
				if (new TextEncoder().encode(value).length > MAX_SEGMENT_BYTES)
					throw new Error(
						`${JSON.stringify(given)} is too long to name a file`,
					);
				return value;
			});
			if (!local && isLocalPath(path))
				throw new Error(
					`${path} would be a .local file, which stays on this computer; ${text} names files that are committed`,
				);
			return path;
		},
	};
}

/** Lowercase only, so two names never differ by case alone on a case-insensitive disk. */
const random = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);

/**
 * A name that sorts by the moment it was made (UTC, to the millisecond),
 * then 8 random lowercase letters and digits so two names made in one
 * millisecond differ. It holds no `.`, `:` or `/`, so it is safe in any path
 * segment and splits cleanly in `{id}.{ext}`.
 *
 * @example
 * ```ts
 * timeId(new Date('2026-10-30T22:41:05.123Z')); // '2026-10-30T22-41-05-123Z-k3x9a2f8'
 * ```
 */
function timeId(at: Date = new Date()): string {
	const stamp = at
		.toISOString()
		.replace(/\.(\d{3})Z$/, '-$1Z')
		.replaceAll(':', '-');
	return `${stamp}-${random()}`;
}
