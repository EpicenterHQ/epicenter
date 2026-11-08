/**
 * Fail when production code (`packages/`, `apps/`) spells `.epicenter`, the
 * directory a folder's unfinished writes live in, outside the two modules
 * that own its layout:
 * `packages/folder/src/state.ts` and the folder core's `state.rs`
 * (`packages/tauri-plugin-epicenter-folder/core/src/state.rs`). Everything
 * else asks them, so a new kind of unfinished write is added there and
 * nowhere else.
 *
 * Exempt:
 *   - The two modules themselves.
 *   - Tests and test support: `*.test.ts` and friends, `*_tests.rs`,
 *     `tests.rs`, `testing.rs`, a Rust `#[cfg(test)] mod` block, and
 *     `smoke/`, `e2e/` and `tests/` directories.
 *   - Comments, and every file that is not code (docs, ADRs, fixtures).
 *
 * A dotted name that merely contains it, such as `so.epicenter.whispering`,
 * `api.epicenter.so` or `.epicenter-whispering-demo`, is not the directory.
 *
 * Run it with `bun run check:state-paths`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
	encoding: 'utf8',
}).trim();

/** The modules that own the layout. */
const OWNERS = new Set([
	'packages/folder/src/state.ts',
	'packages/tauri-plugin-epicenter-folder/core/src/state.rs',
]);

/** Production code lives here; scripts and tooling are not shipped. */
const SCANNED = /^(packages|apps)\//;

const CODE = /\.(ts|tsx|js|mjs|svelte|rs)$/;

const TEST_FILE =
	/(\.test\.[a-z]+|\.test-support\.[a-z.]+|\.test-d\.ts|\.bench\.ts|_tests\.rs|\/tests\.rs|\/testing\.rs)$/;
const TEST_DIRECTORY = /(^|\/)(smoke|e2e|tests|__benchmarks__)\//;

/** The directory itself, not a dotted name that contains it. */
const STATE_DIRECTORY = /(?<![\w.-])\.epicenter(?![\w-])/;

/** A line that is only a comment, or inside a block comment's body. */
const COMMENT = /^\s*(\/\/|\/\*|\*)/;

const tracked = execFileSync('git', ['ls-files', '-z'], {
	cwd: root,
	encoding: 'utf8',
})
	.split('\0')
	.filter(
		(file) =>
			SCANNED.test(file) &&
			CODE.test(file) &&
			!file.endsWith('.d.ts') &&
			!OWNERS.has(file) &&
			!TEST_FILE.test(file) &&
			!TEST_DIRECTORY.test(file),
	);

const violations: string[] = [];
for (const file of tracked) {
	let text: string;
	try {
		text = readFileSync(join(root, file), 'utf8');
	} catch {
		// Tracked but deleted in the working tree.
		continue;
	}
	if (!STATE_DIRECTORY.test(text)) continue;
	const lines = text.split('\n');
	/** In a Rust `#[cfg(test)] mod … {` block, until its closing brace. */
	let inTestModule = false;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] as string;
		if (file.endsWith('.rs')) {
			if (inTestModule) {
				if (line === '}') inTestModule = false;
				continue;
			}
			const next = lines[index + 1] ?? '';
			if (line.trim() === '#[cfg(test)]' && /^mod \w+ \{$/.test(next)) {
				inTestModule = true;
				continue;
			}
		}
		if (COMMENT.test(line) || !STATE_DIRECTORY.test(line)) continue;
		violations.push(`${file}:${index + 1}:${line.trim()}`);
	}
}

if (violations.length === 0) {
	console.log(
		`check:state-paths: ${tracked.length} files scanned, .epicenter is spelled only by its owners.`,
	);
	process.exit(0);
}

console.error(`check:state-paths: ${violations.length} violation(s):\n`);
for (const record of violations) console.error(`  ${record}`);
console.error(
	'\n::error::.epicenter spelled outside its owners. Use STATE_DIRECTORY and the\n' +
		'path builders in @epicenter/folder (state.ts) or the folder core (state.rs).',
);
process.exit(1);
