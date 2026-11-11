/**
 * The kit's stock components against shadcn-svelte's `vega` style.
 *
 * A component with a snapshot in `upstream/shadcn-svelte/vega/<name>/` is
 * stock: its files in `src/<name>/` are what the shadcn-svelte CLI installs,
 * with our import paths, plus at most one patch, `upstream/patches/<name>.diff`.
 * A patch opens with the reason for the change, a line starting `Epicenter:`,
 * before its diff. A component with no snapshot is the kit's own.
 *
 * A snapshot is the CLI's output rather than the registry's response because
 * the CLI finishes the text: it resolves icon placeholders to the configured
 * icon library and drops style hooks the project does not define.
 *
 * ```sh
 * bun scripts/upstream.ts refresh [<name>...]   # install the CLI's current output as snapshots
 * bun scripts/upstream.ts diff <name>           # record src/<name> as a patch, keeping its reason
 * bun scripts/upstream.ts apply <name>...       # rewrite src/<name> as upstream plus its patch
 * ```
 *
 * `upstream.test.ts` checks that every stock component is upstream plus its
 * patch.
 */
import {
	cpSync,
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
const CLI = 'shadcn-svelte@1.8.0';

/**
 * The project `refresh` installs into. The CLI writes imports through these
 * aliases; `upstreamFiles` turns them into the kit's relative paths.
 */
const COMPONENTS_JSON = {
	$schema: 'https://shadcn-svelte.com/schema.json',
	style: 'vega',
	iconLibrary: 'lucide',
	tailwind: { css: 'src/app.css', baseColor: 'neutral' },
	aliases: {
		components: '$lib/components',
		utils: '$lib/utils',
		ui: '$lib/components/ui',
		hooks: '$lib/hooks',
		lib: '$lib',
	},
	typescript: true,
	registry: 'https://shadcn-svelte.com/registry',
};

/** The components with a snapshot. */
export function stockNames(): string[] {
	return readdirSync(VEGA, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

/** Every file under `dir`, keyed by its path relative to `root`. */
function readTree(root: string, dir = root): Map<string, string> {
	const files = new Map<string, string>();
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory())
			for (const [key, content] of readTree(root, path))
				files.set(key, content);
		else files.set(relative(root, path), readFileSync(path, 'utf8'));
	}
	return files;
}

function writeTree(root: string, files: Map<string, string>) {
	for (const [path, content] of files) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
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
	const files = new Map<string, string>();
	for (const [path, content] of readTree(VEGA, join(VEGA, name)))
		files.set(
			path,
			asCommitted(
				path,
				content
					.replaceAll('$lib/components/ui/', '../')
					.replaceAll('$lib/utils', '../utils')
					.replaceAll('$lib/hooks/', '../hooks/'),
			),
		);
	return files;
}

/** Our files for `name`, keyed by path under `src/`; tests are ours alone and left out. */
export function ourFiles(name: string): Map<string, string> {
	const files = readTree(SRC, join(SRC, name));
	for (const path of files.keys())
		if (path.endsWith('.test.ts')) files.delete(path);
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

/**
 * Run a command in a scratch folder. The ceiling stops git from finding a
 * repository above it (a TMPDIR inside one), where `git apply` would apply
 * paths relative to that repository instead.
 */
function run(command: string[], cwd: string) {
	const result = Bun.spawnSync(command, {
		cwd,
		env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) },
	});
	return {
		code: result.exitCode,
		out: result.stdout.toString(),
		err: result.stderr.toString(),
	};
}

/** A scratch folder for `use`, removed afterwards. */
function inScratch<T>(use: (work: string) => T): T {
	const work = mkdtempSync(join(tmpdir(), 'epicenter-upstream-'));
	try {
		return use(work);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/** Upstream's files for `name` with its patch applied; the patch's failure when it does not apply. */
export function patchedUpstream(
	name: string,
): { files: Map<string, string> } | { error: string } {
	const patch = readPatch(name);
	const upstream = upstreamFiles(name);
	if (patch === undefined) return { files: upstream };
	return inScratch((work) => {
		writeTree(join(work, 'tree'), upstream);
		writeFileSync(join(work, 'tree/.patch'), patch);
		const applied = run(
			['git', 'apply', '--whitespace=nowarn', '.patch'],
			join(work, 'tree'),
		);
		if (applied.code !== 0) return { error: applied.err.trim() };
		rmSync(join(work, 'tree/.patch'));
		return { files: readTree(join(work, 'tree')) };
	});
}

/** The diff from upstream's files for `name` to ours, as `git apply` reads it from `src/`. */
export function diffFromUpstream(name: string): string {
	return inScratch((work) => {
		writeTree(join(work, 'up'), upstreamFiles(name));
		writeTree(join(work, 'ours'), ourFiles(name));
		mkdirSync(join(work, 'up', name), { recursive: true });
		mkdirSync(join(work, 'ours', name), { recursive: true });
		const diffed = run(
			['git', 'diff', '--no-index', '--no-color', `up/${name}`, `ours/${name}`],
			work,
		);
		if (diffed.code > 1) throw new Error(diffed.err);
		return diffed.out
			.replaceAll(`a/up/${name}/`, `a/${name}/`)
			.replaceAll(`b/ours/${name}/`, `b/${name}/`)
			.replaceAll(` up/${name}/`, ` ${name}/`)
			.replaceAll(` ours/${name}/`, ` ${name}/`);
	});
}

/**
 * Install `names` with the CLI into a scratch project and save its output.
 * The CLI refuses a project without Svelte and Tailwind, so the scratch
 * project installs both; the components' own dependencies are skipped.
 */
function refresh(names: string[]) {
	const chosen = names.length ? names : stockNames();
	inScratch((work) => {
		writeFileSync(
			join(work, 'package.json'),
			JSON.stringify({
				private: true,
				type: 'module',
				devDependencies: { svelte: '^5', tailwindcss: '^4' },
			}),
		);
		writeFileSync(
			join(work, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					baseUrl: '.',
					paths: { $lib: ['./src/lib'], '$lib/*': ['./src/lib/*'] },
				},
			}),
		);
		writeFileSync(
			join(work, 'components.json'),
			JSON.stringify(COMPONENTS_JSON),
		);
		mkdirSync(join(work, 'src'));
		writeFileSync(join(work, 'src/app.css'), '@import "tailwindcss";\n');
		for (const command of [
			['bun', 'install'],
			['bun', 'x', CLI, 'add', ...chosen, '--yes', '--overwrite', '--no-deps'],
		]) {
			const result = run(command, work);
			if (result.code !== 0)
				throw new Error(
					`${command.join(' ')} failed:\n${result.out}${result.err}`,
				);
		}
		for (const name of chosen) {
			rmSync(join(VEGA, name), { recursive: true, force: true });
			cpSync(join(work, 'src/lib/components/ui', name), join(VEGA, name), {
				recursive: true,
			});
			console.log(`${name}: saved`);
		}
	});
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
	if (command === 'refresh') refresh(names);
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
