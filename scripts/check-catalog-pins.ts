/**
 * Fail when a bun catalog entry uses a floating spec instead of a pinned range.
 *
 * The root `package.json` catalog is the single place this monorepo pins shared
 * dependency versions: every workspace package writes `"dep": "catalog:"` and
 * resolves the real version here. That is the catalog's whole job, so a floating
 * spec (`latest`, `*`, a dist-tag like `next`/`beta`) in the catalog is a
 * contradiction: it reintroduces the exact unpinned drift the catalog exists to
 * eliminate, and it does so invisibly. Nothing breaks at author time; it
 * detonates days later as a `bun install --frozen-lockfile` failure in CI the
 * moment upstream publishes a newer version, on whoever happens to open the next
 * PR. (This is precisely how three `"latest"` entries silently red-walled CI.)
 *
 * The rule: a catalog spec must be a concrete version or semver range
 * (`5.1.14`, `^5.1.14`, `~2.0.0`, `>=1.0.0`). Floating dist-tags and wildcards
 * are rejected. Caret/tilde ranges are fine: under `--frozen-lockfile` bun only
 * validates that the lockfile satisfies the manifest, it does not re-resolve to
 * the newest match, so a pinned range stays put until someone runs a
 * non-frozen install and commits the result.
 *
 * Covers both the default `catalog` and any named `catalogs` (bun supports
 * both). `bun run check` runs it, locally and in CI.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Resolve the repo root so this runs from any cwd.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
	encoding: 'utf8',
}).trim();

// Floating specs a catalog must never carry: dist-tags that move on every
// upstream publish, and wildcards that match anything. A real version or range
// (starts with a digit, `^`, `~`, `>`, `<`, `=`, or `v`) is fine.
const FLOATING_TAGS = new Set([
	'latest',
	'next',
	'canary',
	'beta',
	'alpha',
	'rc',
	'dev',
	'nightly',
	'experimental',
]);
const isFloating = (spec: string): boolean => {
	const value = spec.trim();
	if (value === '') return true;
	if (value === '*' || value.toLowerCase() === 'x') return true;
	if (FLOATING_TAGS.has(value.toLowerCase())) return true;
	// Partial wildcards like `1.x` / `1.*` / `1.2.x`.
	if (/^\d+(\.\d+)?\.(x|\*)$/i.test(value)) return true;
	return false;
};

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
	workspaces?: {
		catalog?: Record<string, string>;
		catalogs?: Record<string, Record<string, string>>;
	};
	catalog?: Record<string, string>;
	catalogs?: Record<string, Record<string, string>>;
};

// bun reads the catalog from either the top level or under `workspaces`.
const ws = pkg.workspaces ?? {};
const defaultCatalog = pkg.catalog ?? ws.catalog ?? {};
const namedCatalogs = pkg.catalogs ?? ws.catalogs ?? {};

const catalogs: { label: string; entries: Record<string, string> }[] = [
	{ label: 'catalog', entries: defaultCatalog },
	...Object.entries(namedCatalogs).map(([name, entries]) => ({
		label: `catalogs.${name}`,
		entries,
	})),
];

const violations: { label: string; dep: string; spec: string }[] = [];
let scanned = 0;
for (const { label, entries } of catalogs) {
	for (const [dep, spec] of Object.entries(entries)) {
		scanned += 1;
		if (isFloating(spec)) violations.push({ label, dep, spec });
	}
}

if (violations.length === 0) {
	console.log(
		`check:catalog-pins: ${scanned} catalog entries scanned, all pinned.`,
	);
	process.exit(0);
}

console.error(
	`check:catalog-pins: ${violations.length} floating catalog spec(s):\n`,
);
for (const { label, dep, spec } of violations) {
	console.error(`  ${label}: "${dep}": "${spec}"`);
}
console.error(
	'\nPin each to a concrete version or range (e.g. "^5.1.14"). A catalog is\n' +
		'the pin; "latest"/"*"/dist-tags reintroduce the lockfile drift it exists\n' +
		'to remove and surface only as a frozen-install failure in CI.',
);
process.exit(1);
