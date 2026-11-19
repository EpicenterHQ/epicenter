// Regenerates docs/spec-history.md from git history.
//
// The ledger is a materialized view of git, not a filesystem snapshot: git is
// the lossless source of truth for every spec that ever existed and when it was
// added, including ones already deleted from the working tree. Regenerating is
// deterministic for a fixed set of refs and never drops history.
//
// Scope is every `specs/` directory repo-wide (top-level plus per-app and
// per-package), by design: all of them share one dated-scaffolding convention
// and one decision home (docs/adr/), so the timeline and the hygiene gate
// (check-doc-hygiene.ts) govern the same corpus.
//
// Ref-sensitivity caveat: the source is `git log --all`, so "every spec that
// ever existed" means "on a ref this clone can see." A clone with extra local
// branches counts more; a fresh shallow clone counts fewer. This is the right
// trade: `--all` is what lets the timeline recover specs that only ever lived
// on an unmerged or since-deleted branch. The count tracks the clone's refs,
// not a universal constant; regeneration on the same refs is byte-identical.
//
// There is deliberately NO status column. A spec's self-declared status lies and
// rots; "is this current?" is answered by docs/adr/, not by this index. The only
// state shown is the factual, never-rotting "in tree" vs "removed".
//
// Run from repo root: bun scripts/generate-spec-history.ts
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

// The specs pathspec keeps the output under the buffer cap: unfiltered
// `--all` across this repo's thousands of agent branches emits gigabytes.
// `--full-history` is required beside it; plain pathspec log simplifies
// history and silently drops adds on TREESAME side branches.
const raw = execFileSync(
	'git',
	[
		'log',
		'--all',
		'--full-history',
		'--diff-filter=A',
		'--name-status',
		'--date=short',
		'--pretty=format:@@@%ad',
		'--',
		'specs',
		':(glob)**/specs/**',
	],
	{ encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
);

const isSpec = (p: string): boolean =>
	/(^|\/)specs\/.*\.md$/.test(p) && !p.endsWith('/README.md');

// git log lists newest first, so the last add we see for a path is its earliest.
let curDate: string | null = null;
const firstAdd = new Map<string, string | null>();
for (const line of raw.split('\n')) {
	if (line.startsWith('@@@')) {
		curDate = line.slice(3).trim();
		continue;
	}
	const path = line.match(/^A\t(.+)$/)?.[1];
	if (path && isSpec(path)) firstAdd.set(path, curDate);
}

function dateOf(path: string): string | null {
	const m = basename(path).match(/^(\d{4})(\d{2})(\d{2})/); // prefer the spec's own dated name
	return m ? `${m[1]}-${m[2]}-${m[3]}` : firstAdd.get(path) || null;
}
function titleOf(path: string): string {
	return (
		basename(path)
			.replace(/\.md$/, '')
			.replace(/^\d{8}T?\d{0,6}/, '')
			.replace(/^[-\s]+/, '')
			.trim() || '(untitled)'
	);
}

type Row = {
	date: string | null;
	title: string;
	path: string;
	present: boolean;
};
type YearGroup = { year: string; rows: Row[] };

const rows: Row[] = [...firstAdd.keys()].map((path) => ({
	date: dateOf(path),
	title: titleOf(path),
	path,
	present: existsSync(path),
}));
rows.sort((a, b) => {
	if (!a.date && !b.date) return a.title.localeCompare(b.title);
	if (!a.date) return 1;
	if (!b.date) return -1;
	return b.date.localeCompare(a.date);
});

const present = rows.filter((r) => r.present).length;

// rows are already sorted (newest date first, undated last), so grouping in
// first-encounter order yields year sections newest-first with "undated"
// trailing: no separate year sort, no Record index that could be undefined.
const groups: YearGroup[] = [];
const groupByYear = new Map<string, YearGroup>();
for (const r of rows) {
	const year = r.date ? r.date.slice(0, 4) : 'undated';
	let group = groupByYear.get(year);
	if (!group) {
		group = { year, rows: [] };
		groupByYear.set(year, group);
		groups.push(group);
	}
	group.rows.push(r);
}

let out = `# Spec History (design timeline)

> **Historical index, not current truth.** Every spec that has ever existed on a
> ref this clone can see, by date, generated from git history so the timeline
> survives any deletion. Scope is every \`specs/\` directory repo-wide.
>
> - For **current decisions and why**, read \`docs/adr/\`.
> - For **how package-owned systems work now**, read the package README and code.
> - For **shared vocabulary**, read \`docs/vision.md\` ("The pieces").
> - To **read a removed spec's body**: \`git log --all --full-history -- "<path>"\` then \`git show <sha>:<path>\`.
>
> A row records that a design was explored on that date. It does not mean the
> design is live. There is no status column on purpose: a spec's self-declared
> status is unreliable, so currentness is owned by \`docs/adr/\`. "State" is the
> only fact shown: whether the spec is still in the working tree.
>
> **Regenerate (deterministic per ref set, lossless):** \`bun scripts/generate-spec-history.ts\`. The totals track the refs this clone can see; \`--all\` is deliberate so the timeline recovers specs that only lived on unmerged or deleted branches.

**${rows.length} specs ever** (${present} still in tree, ${rows.length - present} removed).

`;

for (const { year, rows: yearRows } of groups) {
	out += `\n## ${year}\n\n| Date | Spec | State | Path |\n|------|------|-------|------|\n`;
	for (const r of yearRows) {
		out += `| ${r.date || ''} | ${r.title.replace(/\|/g, '\\|')} | ${r.present ? 'in tree' : 'removed'} | ${r.path} |\n`;
	}
}

writeFileSync('docs/spec-history.md', out);
console.log(
	`Wrote docs/spec-history.md: ${rows.length} specs (${present} in tree, ${rows.length - present} removed)`,
);
