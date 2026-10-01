/**
 * Parse a markdown file into a row: its frontmatter mapping and verbatim body.
 *
 * Two granularities live here, both born from one parse: {@link ParsedFile} (the
 * nameless split {@link parseMarkdown} returns) and {@link Row} (that split plus the
 * file's basename identity, produced by {@link parseEntry}). The basename IS the row
 * id: no id is minted, the name is the key (flat, non-recursive folder, so a basename
 * is unique).
 *
 * Only the frontmatter is structurally parsed (a fenced YAML block at the top);
 * the body is returned verbatim and never AST-parsed. This is what sidesteps
 * markdown's context-sensitivity entirely: the structured layer is YAML, the
 * prose layer is opaque text.
 *
 * The `yaml` package parses with the YAML 1.2 core schema, which does NOT do
 * the YAML 1.1 "Norway problem" coercions (`NO` -> false). That
 * is the deliberate guard against the one real looseness risk in this design.
 *
 * Files we cannot parse safely return an `Err`, split by failure mode (conflict
 * markers, malformed YAML, frontmatter that is not a mapping), so the caller can
 * route them to the "Can't read" bucket instead of guessing. The grid never
 * writes them.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import { parseDocument } from 'yaml';

/** Why a markdown file could not be parsed into a row. */
export const MatterParseError = defineErrors({
	ConflictMarkers: () => ({
		message: 'Contains git conflict markers',
	}),
	InvalidYaml: ({ cause }: { cause: unknown }) => ({
		message: `Frontmatter is not valid YAML: ${extractErrorMessage(cause)}`,
		cause,
	}),
	FrontmatterNotMapping: () => ({
		message: 'Frontmatter is not a key-value mapping',
	}),
});
export type MatterParseError = InferErrors<typeof MatterParseError>;

/** A markdown file split into its frontmatter mapping and verbatim body. */
export type ParsedFile = {
	frontmatter: Record<string, unknown>;
	body: string;
};

/**
 * Leading `---\n...\n---` block. The newline before the closing `---` is
 * optional so an empty block (`---\n---`) matches; tolerates CRLF and an
 * optional trailing newline.
 */
const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** A git conflict marker at the start of any line. */
const CONFLICT_MARKER = /(?:^|\n)(<<<<<<<|=======|>>>>>>>)/;

export function parseMarkdown(
	raw: string,
): Result<ParsedFile, MatterParseError> {
	const startsWithFence = /^---[ \t]*(?:\r?\n|$)/.test(raw);
	const match = startsWithFence ? raw.match(FRONTMATTER) : null;
	if (startsWithFence && !match)
		return MatterParseError.InvalidYaml({
			cause: 'Unclosed frontmatter block',
		});
	// No frontmatter is fine: an empty mapping, the whole file is body.
	if (!match) return Ok({ frontmatter: {}, body: raw });

	// Only frontmatter is structural. Marker examples in the opaque Markdown body
	// are content, not a parse failure; inspecting the whole file here would make
	// Matter contradict its own frontmatter/body boundary.
	const yaml = match[1] ?? '';
	if (CONFLICT_MARKER.test(yaml)) return MatterParseError.ConflictMarkers();

	const { data: parsed, error } = trySync({
		try: () => {
			const document = parseDocument(yaml);
			const problem = document.errors[0] ?? document.warnings[0];
			if (problem) throw problem;
			return document.contents === null ? {} : document.toJS();
		},
		catch: (cause) => MatterParseError.InvalidYaml({ cause }),
	});
	if (error) return Err(error);

	// Frontmatter must be a mapping to be usable as columns. A scalar or list at
	// the top is well-formed YAML but not a row's fields, so treat it as unreadable.
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return MatterParseError.FrontmatterNotMapping();
	}

	return Ok({
		frontmatter: parsed as Record<string, unknown>,
		body: raw.slice(match[0].length),
	});
}

/**
 * A row's identity in reference form: its basename without the `.md` extension, the
 * exact string an author writes in frontmatter (`page: become-the-source`). The ONE
 * definition of stem-from-name, so the reference validator, the live grid, and the
 * report layer all read identity the same way instead of each re-slicing the extension.
 */
export function stemOf(fileName: string): string {
	return fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
}

/**
 * A markdown file read into memory: a {@link ParsedFile} plus the file's basename,
 * which is the row identity. The body is the one rich field, kept verbatim and never
 * AST-parsed; the frontmatter is the typed-column layer. The reference form of that
 * identity (basename without `.md`) is {@link stemOf}, kept a derivation off `fileName`
 * rather than a stored field so hand-built test rows need not carry it.
 */
export type Row = ParsedFile & {
	/** The file's basename, used as the row id (no id is minted). */
	fileName: string;
};

/**
 * Parse one file's content into a row, or the parse error that stopped it. The SINGLE
 * definition of "parse one file into the row-or-unreadable split", shared by
 * {@link readTable} (batch) and the live vault (one delta at a time), so the two
 * cannot drift. The read-level error (only Rust knows a file is undecodable) is the
 * caller's to add; this covers the parse half.
 */
export function parseEntry(
	fileName: string,
	content: string,
): Result<Row, MatterParseError> {
	const { data, error } = parseMarkdown(content);
	if (error) return Err(error);
	return Ok({ fileName, ...data });
}
