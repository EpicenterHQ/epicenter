#!/usr/bin/env bun

/**
 * Fail when a Markdown link inside the skill tree points at nothing.
 *
 * Nothing else in this repository checks these links. `scripts/check-doc-paths.ts`
 * excludes `.agents/` by design and only inspects backtick-wrapped repo-rooted
 * paths, never `](target)` link syntax. So every `references/` link, every
 * `../other-skill/SKILL.md` cross-link, and every heading anchor in a skill can
 * rot silently through a rename, and only a reader clicking it finds out.
 *
 * The shell one-liners in `references/composition-audit.md` cover part of this,
 * but only links written *from* a `SKILL.md` to a `references/*.md` file. Links
 * inside reference files, links to `scripts/`, links to `assets/`, and anchors
 * are all outside their reach. This walks every Markdown file under the skill
 * tree instead.
 *
 * Resolution rules, chosen so the checker stays false-positive free:
 *   - Fenced code blocks and inline code spans are stripped first. Skills carry
 *     example posts and templates with placeholder links like `[here](link)`.
 *   - A target is only treated as a file claim when it contains `/` or ends in
 *     a filename extension. That skips the remaining placeholders.
 *   - `http:`, `https:`, `mailto:`, and bare `#anchor` targets are skipped.
 *   - A relative target resolves against the linking file's directory, so
 *     `../svelte/references/x.md` resolves the same way a reader's
 *     editor resolves it.
 *   - A leading `/` resolves against the repo root.
 *
 * Existence is checked with the filesystem, not `git ls-files`, because a skill
 * directory is portable: the Vercel CLI copies it out of this repository, and a
 * script inside a skill must not require git to run.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LinkFinding = {
	kind: 'DEAD_LINK' | 'DEAD_ANCHOR';
	/** Path of the file containing the link, relative to the scanned root. */
	file: string;
	line: number;
	target: string;
};

const USAGE = `Usage: bun run .agents/skills/skills-and-instructions/scripts/audit-skill-links.ts [options]

Checks every Markdown link under the skill tree against the filesystem.

  --root <dir>   directory to scan (default: the .agents/skills tree)
  --json         emit findings as JSON on stdout
  --help         show this message

Exit codes: 0 no findings, 1 findings reported, 2 usage error.`;

/** Strip fenced blocks and inline code, preserving line numbers. */
export function stripCode(markdown: string): string {
	const lines = markdown.split(/\r?\n/);
	let fence: string | null = null;

	return lines
		.map((line) => {
			const fenceMatch = line.match(/^\s*(```+|~~~+)/);
			if (fenceMatch?.[1]) {
				const marker = fenceMatch[1];
				if (fence === null) {
					fence = marker[0] ?? '`';
					return '';
				}
				if (marker.startsWith(fence)) fence = null;
				return '';
			}
			if (fence !== null) return '';
			return line.replace(/`[^`]*`/g, '');
		})
		.join('\n');
}

/** GitHub-flavored heading slug, close enough for anchors people hand-write. */
export function slugify(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[`*_~]/g, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[^\p{L}\p{N} -]/gu, '')
		.trim()
		.replace(/\s+/g, '-');
}

export function collectHeadingSlugs(markdown: string): Set<string> {
	const slugs = new Set<string>();
	for (const line of stripCode(markdown).split(/\r?\n/)) {
		const heading = line.match(/^#{1,6}\s+(.*)$/);
		if (heading?.[1]) slugs.add(slugify(heading[1]));
	}
	return slugs;
}

// `[text](target)` with an optional title. Targets with whitespace or nested
// parens are not link syntax we write, so the simple form is enough.
const LINK = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EXTERNAL = /^(https?|mailto|tel|ftp|data):/i;

/** Does this target name a file, rather than being prose or a placeholder? */
function isFileClaim(target: string): boolean {
	return target.includes('/') || /\.[A-Za-z0-9]+$/.test(target);
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await listMarkdownFiles(full)));
		else if (entry.name.endsWith('.md')) files.push(full);
	}

	return files.sort();
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

/** Nearest ancestor holding `.git`, used to resolve `/`-rooted link targets. */
async function findRepoRoot(from: string): Promise<string | null> {
	let dir = resolve(from);
	for (;;) {
		if (await exists(join(dir, '.git'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export async function auditLinks(
	root: string,
	repoRoot: string | null,
): Promise<LinkFinding[]> {
	const findings: LinkFinding[] = [];
	const headingCache = new Map<string, Set<string>>();

	for (const file of await listMarkdownFiles(root)) {
		const text = stripCode(await readFile(file, 'utf8'));

		for (const [index, line] of text.split('\n').entries()) {
			for (const match of line.matchAll(LINK)) {
				const raw = match[1];
				if (raw === undefined) continue;
				if (EXTERNAL.test(raw) || raw.startsWith('#')) continue;

				const [pathPart = '', anchor] = raw.split('#', 2);
				if (!pathPart || !isFileClaim(pathPart)) continue;

				const decoded = decodeTarget(pathPart);
				const isRootRelative = decoded.startsWith('/');
				// A `/`-rooted link is only checkable when we found a repo root.
				if (isRootRelative && repoRoot === null) continue;
				const resolved = isRootRelative
					? join(repoRoot as string, decoded)
					: resolve(dirname(file), decoded);

				const finding = {
					file: relative(root, file),
					line: index + 1,
					target: raw,
				};

				if (!(await exists(resolved))) {
					findings.push({ kind: 'DEAD_LINK', ...finding });
					continue;
				}

				if (!anchor || !resolved.endsWith('.md')) continue;

				let slugs = headingCache.get(resolved);
				if (!slugs) {
					slugs = collectHeadingSlugs(await readFile(resolved, 'utf8'));
					headingCache.set(resolved, slugs);
				}
				if (!slugs.has(anchor.toLowerCase()))
					findings.push({ kind: 'DEAD_ANCHOR', ...finding });
			}
		}
	}

	return findings;
}

function decodeTarget(target: string): string {
	try {
		return decodeURIComponent(target);
	} catch {
		return target;
	}
}

if (import.meta.main) {
	const argv = process.argv.slice(2);

	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(USAGE);
		process.exit(0);
	}

	const rootFlag = argv.indexOf('--root');
	if (rootFlag !== -1 && argv[rootFlag + 1] === undefined) {
		console.error(USAGE);
		process.exit(2);
	}

	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const root = resolve(
		rootFlag === -1
			? join(scriptDir, '..', '..')
			: (argv[rootFlag + 1] as string),
	);
	const findings = await auditLinks(root, await findRepoRoot(root));

	if (argv.includes('--json')) {
		console.log(JSON.stringify({ root, findings }, null, 2));
	} else {
		for (const { kind, file, line, target } of findings)
			console.log(`${kind}\t${file}:${line}\t${target}`);
	}

	if (findings.length === 0) {
		console.error(`audit-skill-links: no dead links or anchors under ${root}.`);
		process.exit(0);
	}

	console.error(
		`audit-skill-links: ${findings.length} finding(s). Repoint each link, or delete it if the target is gone.`,
	);
	process.exit(1);
}
