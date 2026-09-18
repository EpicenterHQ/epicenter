/**
 * Fail when a retired word reappears in the store's vocabulary (ADR-0309).
 *
 * A field holds a **value**, replaced whole, or a **node**, edited in place.
 * `scalar` and `prose` were the old names and both were wrong: `tags` is an
 * array and behaves exactly like `title`, and a node holds whatever its table's
 * codec says, which `packages/chat` proves is often not writing at all.
 *
 * The reason this is a script and not a note in a style guide is that ADR-0244
 * settled the same kind of question, shipped no check, and needed a hand-run
 * campaign afterwards. A word that nothing enforces drifts back one comment at a
 * time. This also catches more than vocabulary: a retired word marks text
 * written before a design changed, so the sweep that introduced this file found
 * three documents describing subsystems that had already been deleted.
 *
 * Two rules, scoped differently, because the two words are not alike.
 *
 * `scalar` has no ordinary meaning here, so it is checked almost everywhere. It
 * survives in three kinds of place, all excluded by subsystem: Matter keeps its
 * own copy of the field palette and its own words, `local-books` and
 * `local-mail` genuinely lift scalar columns into SQLite mirrors of their own,
 * and YAML calls a plain node a scalar.
 *
 * `prose` is an ordinary English word, so checking it everywhere would flag the
 * writing skills on every line. It is checked only where the store's vocabulary
 * lives, which `PROSE_SCOPE` lists. That list is the honest statement of the
 * rule's reach; adding a place to it is how the rule grows.
 *
 * `column` is NOT checked. ADR-0269 deleted the SQL projection, so the store has
 * no columns, but Drizzle schemas, table UI, the append-only log's one real
 * SQLite column, and two app-owned mirrors all have real ones. A ban would be
 * mostly exceptions, and an exception list is the thing that rots.
 *
 * For a legitimate use inside a scanned file, put a marker on the line above:
 *   `// vocab-check: ignore-next-line (reason)` in TypeScript and Svelte
 *   `<!-- vocab-check: ignore-next-line (reason) -->` in Markdown
 * or `vocab-check: ignore-file` anywhere in a file that is entirely about the
 * old world.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
	encoding: 'utf8',
}).trim();

// Tracked files only, for the same reason `check-doc-paths.ts` uses it: the
// gate's verdict must not depend on what happens to be lying around untracked
// on the machine that ran it.
const tracked = execFileSync('git', ['ls-files', '-z'], {
	cwd: root,
	encoding: 'utf8',
})
	.split('\0')
	.filter(Boolean);

const SCANNED_EXTENSIONS = ['.ts', '.svelte', '.md'];

/** Dated records and generated output, excluded from every rule. */
const FROZEN = [
	'docs/adr/',
	'docs/articles/',
	'docs/benchmarks/',
	'docs/spec-history.md',
	'specs/',
	'.context/',
	'dist/',
	'drizzle/',
	'.scratch/',
];

type Rule = {
	readonly word: string;
	readonly instead: string;
	/** Paths this rule does not reach. */
	readonly excludes: readonly string[];
	/** When present, the ONLY paths this rule reaches. */
	readonly scope?: readonly string[];
};

const RULES: readonly Rule[] = [
	{
		word: 'scalar',
		instead: 'value',
		excludes: [
			// Matter's universe: its own palette copy, its own words (ADR-0309).
			'apps/matter/',
			'packages/matter-core/',
			// Their own SQLite mirrors, with real extracted scalar columns.
			'apps/local-books/',
			'apps/local-mail/',
			// YAML's word for a plain node, not ours.
			'.agents/skills/agent-instructions/',
		],
	},
	{
		word: 'prose',
		instead: 'node (the container) or text (the characters)',
		excludes: [],
		scope: [
			'packages/data/',
			'packages/chat/',
			'packages/skills/',
			'packages/svelte/',
			'packages/server/workers/',
			'packages/app-shell/',
			'apps/honeycrisp/',
			'apps/whispering/',
			'apps/vocab/',
			'apps/sync-lab/',
			'apps/epicenter/',
			'.agents/skills/yjs/',
			'.agents/skills/svelte/',
			'.agents/skills/collapse-pass/',
			'docs/CONTEXT.md',
			'docs/architecture.md',
			'docs/the-store-and-what-it-replaced.md',
			'README.md',
		],
	},
];

const IGNORE_FILE = /vocab-check:\s*ignore-file\b/;
const IGNORE_NEXT_LINE = /vocab-check:\s*ignore-next-line\b/;

const under = (file: string, prefix: string) =>
	prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix;

const isFrozen = (file: string) =>
	file === 'CHANGELOG.md' ||
	file.endsWith('/CHANGELOG.md') ||
	file.endsWith('.d.ts') ||
	FROZEN.some((dir) => file.startsWith(dir) || file.includes(`/${dir}`));

const applies = (rule: Rule, file: string) => {
	if (rule.excludes.some((dir) => under(file, dir))) return false;
	if (rule.scope === undefined) return true;
	return rule.scope.some((dir) => under(file, dir));
};

const files = tracked.filter(
	(file) =>
		SCANNED_EXTENSIONS.some((ext) => file.endsWith(ext)) &&
		!isFrozen(file) &&
		// `git ls-files` still lists a tracked file deleted in an unstaged
		// worktree, so a cleanup branch can run this before staging the deletion.
		existsSync(join(root, file)),
);

const violations: {
	file: string;
	line: number;
	word: string;
	instead: string;
	text: string;
}[] = [];

for (const file of files) {
	const rules = RULES.filter((rule) => applies(rule, file));
	if (rules.length === 0) continue;

	const text = readFileSync(join(root, file), 'utf8');
	if (IGNORE_FILE.test(text)) continue;

	const lines = text.split('\n');
	lines.forEach((line, i) => {
		const previous = lines[i - 1];
		if (previous !== undefined && IGNORE_NEXT_LINE.test(previous)) return;
		if (IGNORE_NEXT_LINE.test(line) || IGNORE_FILE.test(line)) return;
		for (const { word, instead } of rules) {
			// `\B` after the stem lets `scalars` and `Scalar` match while keeping
			// `ProseMirror` and `prose-css` out: a following letter is fine, a
			// following capital or hyphen is a different word.
			const pattern = new RegExp(`\\b${word}(s)?\\b`, 'i');
			if (!pattern.test(line)) continue;
			if (/ProseMirror/.test(line) && word === 'prose') {
				if (!/\bprose(s)?\b/i.test(line.replace(/ProseMirror/g, ''))) continue;
			}
			violations.push({
				file,
				line: i + 1,
				word,
				instead,
				text: line.trim().slice(0, 100),
			});
		}
	});
}

if (violations.length === 0) {
	console.log(
		`check:vocabulary: ${files.length} files scanned, no retired words.`,
	);
	process.exit(0);
}

console.error(`check:vocabulary: ${violations.length} retired word(s):\n`);
for (const { file, line, word, instead, text } of violations) {
	console.error(
		`::error file=${file},line=${line}::"${word}" is retired; use ${instead} (ADR-0309)`,
	);
	console.error(`  ${file}:${line}  ${text}`);
}
console.error(
	'\nA field holds a value, replaced whole, or a node, edited in place (ADR-0309).\n' +
		'If a use is legitimate, mark the line above it with `vocab-check: ignore-next-line (reason)`.',
);
process.exit(1);
