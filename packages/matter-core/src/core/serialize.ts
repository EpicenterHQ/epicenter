/**
 * Serialize an entry back to markdown text (the write half of the round-trip).
 *
 * Frontmatter is the typed-COLUMN layer, so the app owns its formatting and
 * re-emits it canonically (eemeli `yaml` `stringify`): key order follows the
 * object (which is disk order, since the caller edits a freshly parsed mapping;
 * a newly set key appends). Empty mappings retain a fence so clearing the last
 * field still produces a row file. The
 * body is the one rich field and is written VERBATIM, never reparsed, so prose
 * and any comments you care about live there and survive untouched.
 *
 * This is value-identity, not byte-identity. A parseable file round-trips to the
 * same VALUES (YAML 1.2 core, no Norway coercion), which is all a typed table
 * needs; exact quoting, whitespace, and frontmatter comments are not preserved.
 * That is the deliberate clean break from surgical, byte-preserving write-back:
 * "frontmatter is columns" and "byte-identical frontmatter" are in tension, and
 * the column reading wins. An invalid-AGAINST-THE-CONTRACT value is still a valid
 * YAML scalar, so it survives here by value and stays editable in place; only an
 * UNPARSEABLE file would lose, and the grid never writes those.
 *
 * Clearing a field is the caller deleting the key before it reaches here (the
 * nullish contract: a removed key, never `key: null`); an existing `key: null`
 * is a real value and round-trips as `null`.
 */

import { stringify } from 'yaml';
import { parseMarkdown } from './parse';

export function serializeEntry(
	frontmatter: Record<string, unknown>,
	body: string,
): string {
	return `---\n${stringify(frontmatter)}---\n${body}`;
}

/**
 * Apply one field edit to raw markdown: parse the freshest bytes, set or clear
 * one frontmatter key, re-emit canonically with the body verbatim.
 * `value === undefined` CLEARS the field (deletes the key, never writes `null`:
 * the nullish contract). An UNPARSEABLE file is returned unchanged, since the
 * grid never edits those.
 *
 * This IS the vault's field-write transform, exported so the round-trip contract
 * is exercised directly instead of re-implemented in the test.
 */
export function editField(raw: string, key: string, value: unknown): string {
	const { data } = parseMarkdown(raw);
	if (!data) return raw;
	const frontmatter = { ...data.frontmatter };
	if (value === undefined) delete frontmatter[key];
	else frontmatter[key] = value;
	return serializeEntry(frontmatter, data.body);
}

/**
 * Replace a file's body, keeping its frontmatter values intact (the body-write
 * half of the same parse-edit-serialize transform). Unparseable files are
 * returned unchanged.
 */
export function editBody(raw: string, body: string): string {
	const { data } = parseMarkdown(raw);
	if (!data) return raw;
	return serializeEntry(data.frontmatter, body);
}
