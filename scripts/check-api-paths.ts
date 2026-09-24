/**
 * Fail when a wire URL path Epicenter serves or calls is hardcoded outside
 * packages/constants.
 *
 * Every wire URL path lives in one place:
 * packages/constants/src/api-routes.ts. Consumers import patterns and
 * URL builders from there. See
 * specs/20260524T153612-centralize-route-paths.md.
 *
 * Excluded (per spec § Decisions Log):
 *   - The constants files themselves (they ARE the source of truth).
 *   - Vendored mirrors that intentionally re-declare these paths to avoid a
 *     runtime dependency on @epicenter/constants (apps/epicenter/src/routes.ts,
 *     whose /api/session is the shell's own loopback contract, not the cloud
 *     session endpoint).
 *   - *.test.ts / *.test.tsx (mock URL matchers may reference paths verbatim).
 *   - JSDoc/comment lines (descriptive prose, not constructions).
 *
 * A straight port of the grep pipeline that used to live inline in
 * .github/workflows/ci.format.yml, so the rule is locally runnable:
 * bun run check:api-paths
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Resolve the repo root so this runs from any cwd.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
	encoding: 'utf8',
}).trim();

const SCAN_ROOTS = ['packages', 'apps'];
const EXCLUDED_DIRS = new Set([
	'node_modules',
	'dist',
	'.wrangler',
	'.next',
	'.svelte-kit',
]);

// A quoted route literal for a path @epicenter/constants owns. `([^a-z]|$)`
// keeps `/api/sessions-of-mine` style prefixes from matching.
const HARDCODED_PATH = /['"`]\/api\/(session|rooms|blobs|ai)([^a-z]|$)/;

// The next two regexes test the full `path:line:content` record, exactly as
// the workflow's `grep -v` filters did.
const ALLOWED_RECORD =
	/packages\/constants\/src\/api-routes\.ts|apps\/epicenter\/src\/routes\.ts/;
const COMMENT_RECORD = /^[^:]+:[0-9]+:[ \t\v\f\r]*(\*|\/\/|\/\*)/;

const isScannedFile = (name: string): boolean =>
	(name.endsWith('.ts') || name.endsWith('.tsx')) &&
	!name.endsWith('.test.ts') &&
	!name.endsWith('.test.tsx');

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (EXCLUDED_DIRS.has(entry.name)) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(path);
		else if (entry.isFile() && isScannedFile(entry.name)) yield path;
	}
}

const violations: string[] = [];
let scanned = 0;
for (const scanRoot of SCAN_ROOTS) {
	const dir = join(root, scanRoot);
	if (!existsSync(dir)) continue;
	for (const path of walk(dir)) {
		scanned += 1;
		const lines = readFileSync(path, 'utf8').split('\n');
		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i] as string;
			if (!HARDCODED_PATH.test(line)) continue;
			const record = `${scanRoot}${path.slice(dir.length)}:${i + 1}:${line}`;
			if (ALLOWED_RECORD.test(record)) continue;
			if (COMMENT_RECORD.test(record)) continue;
			violations.push(record);
		}
	}
}

if (violations.length === 0) {
	console.log(
		`check:api-paths: ${scanned} files scanned, no hardcoded API path literals.`,
	);
	process.exit(0);
}

console.error(`check:api-paths: ${violations.length} violation(s):\n`);
for (const record of violations) {
	console.error(`  ${record}`);
}
console.error(
	'\n::error::Hardcoded API path literal found. Use API_ROUTES.* from\n' +
		'@epicenter/constants/api-routes instead.',
);
process.exit(1);
