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
 * reference to a gitignored build artifact (`apps/landing/dist/index.html`) or a
 * stray local scratch file pass on the machine that wrote it and fail on a fresh
 * clone, making the gate's verdict depend on who ran it.
 *
 * Scope is deliberately narrow to stay false-positive free:
 *   - Only backtick-wrapped tokens with a filename extension are treated as
 *     file claims (prose dir mentions and `@scope/pkg` names are not).
 *   - An optional `:42` / `:42:7` / `:42-50` line suffix is allowed and ignored.
 *   - A token containing a `...` path ellipsis is skipped: it is a pattern.
 *   - A path qualified by a git ref (`folder-sync-product:apps/epicenter/AGENTS.md`)
 *     is a citation of history, not a claim about the tree, so it is not a file
 *     token. Its ref may be absent from a shallow CI clone, so it is not checked.
 *
 * Excluded from the scan, because their paths are illustrative or frozen:
 *   - `specs/` at any depth: dated records, kept stale.
 *   - `.agents/` and `.claude/`: skill and agent prompts cite example paths
 *     like `apps/whatever/src/lib/feature.ts` as teaching stand-ins.
 *   - any doc carrying `<!-- doc-path-check: ignore-file -->`. Mark a historical
 *     doc this way: a living doc that merely *mentions* history stays scanned.
 *
 * For a single deliberately illustrative path inside a scanned doc, put
 * `<!-- doc-path-check: ignore-next-line -->` on the line above it.
 *
 * The same gate also checks relative Markdown links, `[text](path#anchor)`:
 *   - the target must be a tracked file (or a directory holding tracked files),
 *     resolved against the linking file's directory;
 *   - a `#anchor` into a `.md` target must match one of its headings, using
 *     GitHub's slugs (`-1`, `-2` for repeated headings); a bare `#anchor`
 *     checks the linking file itself.
 *   - Link scope is wider than the backtick scope: `.agents/` and `.claude/`
 *     docs are scanned too, since their links are real. Only `specs/`,
 *     `docs/history.md` and `ignore-file` docs are skipped.
 *   - Fenced code and inline code are ignored, as are `http(s):`/`mailto:`
 *     targets and placeholders that are not path-shaped.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import {
	collectHeadingSlugs,
	EXTERNAL,
	isFileClaim,
	LINK,
	stripCode,
} from '../.agents/skills/skills-and-instructions/scripts/audit-skill-links.ts';

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

const EXCLUDED_DOC_DIRS = ['specs', '.agents', '.claude'];
const REPO_ROOT_DIRS = ['apps', 'packages', 'docs', 'specs', 'scripts'];

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

// Link scan: every tracked Markdown doc except frozen records.
const linkDocs = tracked.filter(
	(file) =>
		file.endsWith('.md') &&
		file !== 'docs/history.md' &&
		!(file.startsWith('specs/') || file.includes('/specs/')) &&
		existsSync(join(root, file)),
);
const trackedDirs = new Set<string>();
for (const file of tracked) {
	for (let dir = posix.dirname(file); dir !== '.'; dir = posix.dirname(dir)) {
		trackedDirs.add(dir);
	}
}
const slugCache = new Map<string, Set<string>>();
const slugsFor = (file: string) => {
	let slugs = slugCache.get(file);
	if (!slugs) {
		slugs = collectHeadingSlugs(readFileSync(join(root, file), 'utf8'));
		slugCache.set(file, slugs);
	}
	return slugs;
};
const decode = (s: string) => {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
};

const linkViolations: {
	file: string;
	line: number;
	target: string;
	reason: string;
}[] = [];

for (const file of linkDocs) {
	const raw = readFileSync(join(root, file), 'utf8');
	if (IGNORE_FILE.test(raw)) continue;
	const rawLines = raw.split('\n');
	const lines = stripCode(raw).split('\n');
	lines.forEach((line, i) => {
		const prev = rawLines[i - 1];
		if (prev !== undefined && IGNORE_NEXT_LINE.test(prev)) return;
		for (const match of line.matchAll(LINK)) {
			const target = match[1];
			if (target === undefined || EXTERNAL.test(target)) continue;
			const hash = target.indexOf('#');
			const pathPart = hash === -1 ? target : target.slice(0, hash);
			const anchor = hash === -1 ? undefined : decode(target.slice(hash + 1));
			let resolved = file;
			if (pathPart) {
				if (!isFileClaim(pathPart)) continue;
				const decoded = decode(pathPart);
				resolved = decoded.startsWith('/')
					? posix.normalize(decoded.slice(1))
					: posix.normalize(posix.join(dirname(file), decoded));
				const bare = resolved.replace(/\/$/, '');
				if (
					bare.startsWith('..') ||
					!(trackedPaths.has(bare) || trackedDirs.has(bare))
				) {
					linkViolations.push({
						file,
						line: i + 1,
						target,
						reason: 'no such file',
					});
					continue;
				}
				resolved = bare;
			}
			if (!anchor || !resolved.endsWith('.md') || !trackedPaths.has(resolved)) {
				continue;
			}
			if (!slugsFor(resolved).has(anchor.toLowerCase())) {
				linkViolations.push({
					file,
					line: i + 1,
					target,
					reason: `no heading for #${anchor}`,
				});
			}
		}
	});
}

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

if (violations.length === 0 && linkViolations.length === 0) {
	console.log(
		`check:doc-paths: ${docs.length} docs scanned, all paths resolve; ${linkDocs.length} docs scanned, all links resolve.`,
	);
	process.exit(0);
}

if (violations.length > 0) {
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
}
if (linkViolations.length > 0) {
	console.error(
		`check:doc-paths: ${linkViolations.length} dead Markdown link(s):\n`,
	);
	for (const { file, line, target, reason } of linkViolations) {
		console.error(`  ${file}:${line}  (${target})  ${reason}`);
	}
	console.error('\nRepoint each link, or remove it if the target is gone.');
}
process.exit(1);
