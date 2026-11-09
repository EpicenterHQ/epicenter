/**
 * Read the routing surfaces and classify what they claim.
 *
 * Three scripts need the same two primitives: enumerate `<skills>/*\/SKILL.md`
 * and pull one frontmatter field out of it. This module owns both so the
 * frontmatter parser has one definition rather than one copy per script.
 *
 * A skill description is not the only surface that routes. `AGENTS.md` is
 * loaded before any description is weighed and names skills directly, so it
 * claims phrases too, and a live probe obeys it: an `AGENTS.md` sentence
 * sending overflow reports to `documentation` beat `styling`'s own description
 * 3 times out of 3. This module owns that surface as well, so a script that
 * asks who claims a phrase can see both.
 *
 * `classifyClaim` exists because substring matching over-reports. Descriptions
 * in this repository carry near-miss clauses ("For a broad \"simplify this\"
 * pass over a diff or package, use collapse-pass instead."), so a description
 * that mentions a phrase is as likely to be *routing it away* as claiming it.
 * Splitting the description into sentences and reading the sentence that
 * carries the phrase separates the two cases. This is still lexical: it reports
 * what a description says, never what a model does.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type SkillEntry = {
	/** Directory name, which is also the skill name the CLI discovers. */
	name: string;
	/** The `description` frontmatter field, joined onto one line. */
	description: string;
	/** Absolute path to the skill's `SKILL.md`. */
	skillPath: string;
};

/**
 * The always-on files an agent carries before it weighs a single description.
 *
 * Nested `AGENTS.md` files are deliberately out of scope: they load for work
 * inside their own directory, not for every task in the repository.
 */
export const ALWAYS_ON_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

export type AlwaysOnEntry = {
	/** Repository-relative path, in `ALWAYS_ON_FILES` order. */
	path: string;
	contents: string;
};

/** Read every always-on file the repository actually has. */
export async function readAlwaysOnInstructions(
	root: string,
): Promise<AlwaysOnEntry[]> {
	const entries: AlwaysOnEntry[] = [];

	for (const path of ALWAYS_ON_FILES) {
		const contents = await readFile(join(root, path), 'utf8').catch(
			(error: unknown) => {
				if (
					error instanceof Error &&
					'code' in error &&
					error.code === 'ENOENT'
				)
					return null;
				throw error;
			},
		);
		if (contents === null) continue;

		entries.push({ path, contents });
	}

	return entries;
}

/**
 * What a description does with a phrase.
 *
 * - `claims`: at least one sentence carries the phrase as a trigger.
 * - `disclaims`: every sentence carrying the phrase routes it elsewhere.
 * - `absent`: the description never mentions the phrase.
 */
export type ClaimVerdict = 'claims' | 'disclaims' | 'absent';

/**
 * Enumerate every skill directory that has a `SKILL.md`, sorted by name.
 *
 * Directories without a `SKILL.md` are skipped rather than reported: the
 * "stub directory" check belongs to the composition audit, not here.
 */
export async function readSkillCatalog(
	skillsDir: string,
): Promise<SkillEntry[]> {
	const entries = await readdir(skillsDir, { withFileTypes: true });
	const skills: SkillEntry[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;

		const skillPath = join(skillsDir, entry.name, 'SKILL.md');
		const contents = await readFile(skillPath, 'utf8').catch(
			(error: unknown) => {
				if (
					error instanceof Error &&
					'code' in error &&
					error.code === 'ENOENT'
				)
					return null;
				throw error;
			},
		);
		if (contents === null) continue;

		skills.push({
			name: entry.name,
			description: extractFrontmatterField(contents, 'description'),
			skillPath,
		});
	}

	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read one top-level frontmatter field, joining block scalars onto one line.
 *
 * Returns an empty string when the file has no frontmatter or no such field.
 */
export function extractFrontmatterField(
	markdown: string,
	fieldName: string,
): string {
	const lines = markdown.split(/\r?\n/);
	if (lines[0] !== '---') return '';

	const fieldPrefix = `${fieldName}:`;
	const values: string[] = [];
	let isReadingField = false;

	for (const line of lines.slice(1)) {
		if (line === '---') break;

		const startsNewField = /^[A-Za-z0-9_-]+:/.test(line);
		if (startsNewField) {
			if (isReadingField) break;

			if (line.startsWith(fieldPrefix)) {
				isReadingField = true;
				values.push(line.slice(fieldPrefix.length).trim());
			}

			continue;
		}

		if (isReadingField) values.push(line.trim());
	}

	return values.join(' ').replace(/^['"]|['"]$/g, '');
}

// A sentence routes a phrase away when it names another destination. These are
// the forms the repository's descriptions actually use.
const DISCLAIMER =
	/\b(instead|rather than|not for|do not use|don't use|never use)\b/i;

/**
 * Decide whether `description` claims `phrase`, routes it away, or omits it.
 *
 * Matching is case-insensitive and substring-based, so "hand off" matches
 * "hand off the implementation". A phrase that appears only inside near-miss
 * sentences is reported as `disclaims`.
 */
export function classifyClaim(
	description: string,
	phrase: string,
): ClaimVerdict {
	const needle = phrase.toLowerCase().trim();
	if (!needle) return 'absent';

	// Split on sentence-ending punctuation followed by whitespace, which leaves
	// `console.*` and `.agents/skills` intact.
	const sentences = description.split(/(?<=[.;:])\s+/);
	const carrying = sentences.filter((sentence) =>
		sentence.toLowerCase().includes(needle),
	);

	if (carrying.length === 0) return 'absent';
	return carrying.every((sentence) => DISCLAIMER.test(sentence))
		? 'disclaims'
		: 'claims';
}
