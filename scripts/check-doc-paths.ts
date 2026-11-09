/**
 * Fail when a living doc cites a repo-rooted file path that does not exist.
 *
 * Stale `apps/...`/`packages/...` references accrue after every refactor that
 * moves or deletes files (the worker collapse, the dashboard removal, app
 * restructures). They are invisible to typecheck and lint because they live in
 * Markdown, so they rot silently until someone clicks a dead link. This walks
 * every backtick-wrapped file path in the canonical docs and checks it against
 * the tracked file set.
 *
 * Tracked, not `existsSync`, on both sides of the gate: a doc may only cite what
 * the repository actually ships. Resolving against the filesystem would let a
 * reference to a gitignored build artifact (`packages/workspace/dist/index.js`) or a
 * stray local scratch file pass on the machine that wrote it and fail on a fresh
 * clone, making the gate's verdict depend on who ran it.
 *
 * Scope is deliberately narrow to stay false-positive free:
 *   - Only backtick-wrapped tokens with a filename extension are treated as
 *     file claims (prose dir mentions and `@scope/pkg` names are not).
 *   - An optional `:42` / `:42:7` / `:42-50` line suffix is allowed and ignored.
 *   - A token containing a `...` path ellipsis is skipped: it is a pattern.
 *
 * Excluded from the scan, because their paths are illustrative or frozen:
 *   - `specs/` and `docs/articles/` at any depth: dated records, kept stale.
 *   - `.agents/` and `.claude/`: skill and agent prompts cite example paths
 *     like `apps/whatever/src/lib/feature.ts` as teaching stand-ins.
 *   - any doc carrying `<!-- doc-path-check: ignore-file -->`. Mark a historical
 *     doc this way: a living doc that merely *mentions* history stays scanned.
 *
 * For a single deliberately illustrative path inside a scanned doc, put
 * `<!-- doc-path-check: ignore-next-line -->` on the line above it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Resolve the repo root so paths resolve regardless of the invoking cwd.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
	encoding: 'utf8',
}).trim();

// `git ls-files` is the load-bearing choice for selecting docs to scan: it
// yields tracked files only, so node_modules, dist, and every .gitignored output
// are skipped for free, which `Bun.Glob` (no .gitignore awareness) cannot do.
// `-z` survives odd filenames.
const tracked = execFileSync('git', ['ls-files', '-z'], {
	cwd: root,
	encoding: 'utf8',
})
	.split('\0')
	.filter(Boolean);
const trackedPaths = new Set(tracked);

const EXCLUDED_DOC_DIRS = ['specs', 'docs/articles', '.agents', '.claude'];
const REPO_ROOT_DIRS = [
	'apps',
	'packages',
	'docs',
	'specs',
	'scripts',
	'examples',
	'playground',
];

const isExcludedDoc = (file: string) =>
	EXCLUDED_DOC_DIRS.some(
		(dir) => file.startsWith(`${dir}/`) || file.includes(`/${dir}/`),
	);

const FILE_TOKEN =
	/`([A-Za-z0-9._/-]+\.[A-Za-z0-9]+)(?::\d+(?::\d+)?(?:-\d+)?)?`/g;
// `\b.*?-->` lets a marker carry a trailing reason, e.g.
// `<!-- doc-path-check: ignore-file (frozen historical record) -->`.
const IGNORE_FILE = /<!--\s*doc-path-check:\s*ignore-file\b.*?-->/;
const IGNORE_NEXT_LINE = /<!--\s*doc-path-check:\s*ignore-next-line\b.*?-->/;

const docs = tracked.filter((file) => {
	if (!file.endsWith('.md') || isExcludedDoc(file)) return false;
	// `git ls-files` still includes tracked files deleted in an unstaged
	// worktree. Skip them here so cleanup branches can run the checker before
	// staging the deletion.
	return existsSync(join(root, file));
});
const violations: { file: string; line: number; path: string }[] = [];

for (const file of docs) {
	const text = readFileSync(join(root, file), 'utf8');
	if (IGNORE_FILE.test(text)) continue;

	const lines = text.split('\n');
	lines.forEach((line, i) => {
		const prev = lines[i - 1];
		if (prev !== undefined && IGNORE_NEXT_LINE.test(prev)) return;
		for (const match of line.matchAll(FILE_TOKEN)) {
			const path = match[1];
			if (path === undefined) continue;
			if (
				path.includes('...') ||
				!REPO_ROOT_DIRS.some((dir) => path.startsWith(`${dir}/`))
			) {
				continue;
			}
			if (!trackedPaths.has(path)) {
				violations.push({ file, line: i + 1, path });
			}
		}
	});
}

if (violations.length === 0) {
	console.log(
		`check:doc-paths: ${docs.length} docs scanned, all paths resolve.`,
	);
	process.exit(0);
}

console.error(
	`check:doc-paths: ${violations.length} dead file reference(s):\n`,
);
for (const { file, line, path } of violations) {
	console.error(`  ${file}:${line}  ${path}`);
}
console.error(
	'\nRepoint each to the real path. If a path is intentionally illustrative,\n' +
		'mark the line above it with `<!-- doc-path-check: ignore-next-line -->`.',
);
process.exit(1);
