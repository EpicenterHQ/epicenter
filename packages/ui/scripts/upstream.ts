/**
 * The kit's stock components against shadcn-svelte's `vega` registry.
 *
 * A component with a saved response in `upstream/shadcn-svelte/vega/` is
 * stock: its files in `src/<name>/` are upstream's text with our import paths,
 * plus at most one patch, `upstream/patches/<name>.diff`. A patch opens with
 * the reason for the change, a line starting `Epicenter:`, before its diff.
 * A component with no saved response is the kit's own.
 *
 * ```sh
 * bun scripts/upstream.ts refresh [<name>...]   # save the registry's current responses
 * bun scripts/upstream.ts diff <name>           # record src/<name> as a patch, keeping its reason
 * bun scripts/upstream.ts apply <name>...       # rewrite src/<name> as upstream plus its patch
 * ```
 *
 * `upstream.test.ts` checks that every stock component is upstream plus its
 * patch.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const PACKAGE = join(import.meta.dir, '..');
export const SRC = join(PACKAGE, 'src');
const VEGA = join(PACKAGE, 'upstream/shadcn-svelte/vega');
const PATCHES = join(PACKAGE, 'upstream/patches');
const REGISTRY = 'https://shadcn-svelte.com/registry/styles/vega';

/** A file a registry response installs: its path under the component, and its text. */
type RegistryFile = { target: string; content: string };

/** The components with a saved `vega` response. */
export function stockNames(): string[] {
	return readdirSync(VEGA)
		.filter((file) => file.endsWith('.json'))
		.map((file) => file.slice(0, -'.json'.length))
		.sort();
}

/**
 * `content` as the repository's formatter writes it at `path` under `src/`.
 * Biome formats and sorts `.ts` files and leaves `.svelte` alone, so a `.ts`
 * file from upstream is compared as it would be committed.
 */
function asCommitted(path: string, content: string): string {
	if (!path.endsWith('.ts')) return content;
	const run = Bun.spawnSync(
		[
			join(PACKAGE, '../../node_modules/.bin/biome'),
			'check',
			'--write',
			'--linter-enabled=false',
			`--stdin-file-path=packages/ui/src/${path}`,
		],
		{ cwd: join(PACKAGE, '../..'), stdin: Buffer.from(content) },
	);
	if (run.exitCode !== 0)
		throw new Error(`biome could not format ${path}: ${run.stderr}`);
	return run.stdout.toString();
}

/** Upstream's files for `name`, keyed by path under `src/`, with our import paths, as committed. */
export function upstreamFiles(name: string): Map<string, string> {
	const response = JSON.parse(
		readFileSync(join(VEGA, `${name}.json`), 'utf8'),
	) as { files: RegistryFile[] };
	return new Map(
		response.files.map((file) => [
			file.target,
			asCommitted(
				file.target,
				file.content
					.replaceAll('$UTILS$', '../utils')
					.replaceAll('$UI$', '..')
					.replaceAll('$HOOKS$', '../hooks'),
			),
		]),
	);
}

/** Our files for `name`, keyed by path under `src/`; tests are ours alone and left out. */
export function ourFiles(name: string): Map<string, string> {
	const files = new Map<string, string>();
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (!/\.test\.ts$|\.mounted\.test\.ts$/.test(entry.name))
				files.set(relative(SRC, path), readFileSync(path, 'utf8'));
		}
	};
	walk(join(SRC, name));
	return files;
}

/** The patch for `name`, or `undefined` when the component is upstream's text. */
export function readPatch(name: string): string | undefined {
	const path = join(PATCHES, `${name}.diff`);
	return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** A patch's reason: the text before its first `diff --git`. */
export function reasonOf(patch: string): string {
	const start = patch.indexOf('diff --git ');
	return (start === -1 ? patch : patch.slice(0, start)).trim();
}

function writeTree(root: string, files: Map<string, string>) {
	for (const [path, content] of files) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

function git(args: string[], cwd: string) {
	const run = Bun.spawnSync(['git', ...args], { cwd });
	return {
		code: run.exitCode,
		out: run.stdout.toString(),
		err: run.stderr.toString(),
	};
}

/** Upstream's files for `name` with its patch applied; the patch's failure when it does not apply. */
export function patchedUpstream(
	name: string,
): { files: Map<string, string> } | { error: string } {
	const patch = readPatch(name);
	const upstream = upstreamFiles(name);
	if (patch === undefined) return { files: upstream };
	const work = mkdtempSync(join(tmpdir(), 'epicenter-upstream-'));
	try {
		writeTree(work, upstream);
		writeFileSync(join(work, '.patch'), patch);
		const applied = git(['apply', '--whitespace=nowarn', '.patch'], work);
		if (applied.code !== 0) return { error: applied.err.trim() };
		rmSync(join(work, '.patch'));
		const files = new Map<string, string>();
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) walk(path);
				else files.set(relative(work, path), readFileSync(path, 'utf8'));
			}
		};
		walk(work);
		return { files };
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/** The diff from upstream's files for `name` to ours, as `git apply` reads it from `src/`. */
export function diffFromUpstream(name: string): string {
	const work = mkdtempSync(join(tmpdir(), 'epicenter-upstream-'));
	try {
		writeTree(join(work, 'up'), upstreamFiles(name));
		writeTree(join(work, 'ours'), ourFiles(name));
		mkdirSync(join(work, 'up', name), { recursive: true });
		mkdirSync(join(work, 'ours', name), { recursive: true });
		const diffed = git(
			['diff', '--no-index', '--no-color', `up/${name}`, `ours/${name}`],
			work,
		);
		if (diffed.code > 1) throw new Error(diffed.err);
		return diffed.out
			.replaceAll(`a/up/${name}/`, `a/${name}/`)
			.replaceAll(`b/ours/${name}/`, `b/${name}/`)
			.replaceAll(` up/${name}/`, ` ${name}/`)
			.replaceAll(` ours/${name}/`, ` ${name}/`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

async function refresh(names: string[]) {
	for (const name of names.length ? names : stockNames()) {
		const response = await fetch(`${REGISTRY}/${name}.json`);
		if (!response.ok) {
			console.error(`${name}: ${response.status}`);
			continue;
		}
		writeFileSync(join(VEGA, `${name}.json`), await response.text());
		console.log(`${name}: saved`);
	}
}

function recordPatch(name: string) {
	const diff = diffFromUpstream(name);
	const path = join(PATCHES, `${name}.diff`);
	if (diff === '') {
		rmSync(path, { force: true });
		console.log(`${name}: upstream's text; no patch`);
		return;
	}
	const reason =
		reasonOf(readPatch(name) ?? '') ||
		'Epicenter: <why this component differs from upstream, and which caller needs it>';
	mkdirSync(PATCHES, { recursive: true });
	writeFileSync(path, `${reason}\n\n${diff}`);
	console.log(`${name}: patch recorded at ${relative(PACKAGE, path)}`);
}

function applyPatch(name: string) {
	const result = patchedUpstream(name);
	if ('error' in result) {
		console.error(`${name}: the patch does not apply: ${result.error}`);
		return false;
	}
	for (const path of ourFiles(name).keys())
		if (!result.files.has(path)) rmSync(join(SRC, path));
	writeTree(SRC, result.files);
	console.log(`${name}: rewritten from upstream and its patch`);
	return true;
}

if (import.meta.main) {
	const [command, ...names] = process.argv.slice(2);
	const [only] = names;
	if (command === 'refresh') await refresh(names);
	else if (command === 'diff' && only !== undefined && names.length === 1)
		recordPatch(only);
	else if (command === 'apply' && names.length > 0)
		process.exitCode = names.map(applyPatch).every(Boolean) ? 0 : 1;
	else {
		console.error(
			'Usage: bun scripts/upstream.ts refresh [<name>...] | diff <name> | apply <name>...',
		);
		process.exitCode = 2;
	}
}
