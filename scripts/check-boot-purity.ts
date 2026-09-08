// Boot-purity check. Deterministic, fixable-in-loop, CI-optional.
//
// Browser app lib modules must not top-level await: a module-evaluation
// rejection (for example the named held-storage failure when a suspended
// Safari tab retains the OPFS access handles) blanks the page before any
// Svelte error surface can mount. The Safari gate falsified exactly this on
// 2026-07-18. The contract: `runtime.open()` is asynchronous and resolves
// only with a ready handle, and every fallible acquisition runs inside a
// mounted observer. Whispering and Honeycrisp synchronously create one
// application-opening promise in a mounted component and render it through a
// stable `{#await}` boundary. Their library modules remain inert.
//
// This is a tripwire, not a parser: it flags `await` at module scope using a
// brace/paren depth heuristic over the app lib trees. Top-level await inside
// a nested expression could slip through; anything flagged is a real find.
//
// Exit non-zero if anything is flagged. Run from repo root:
// bun scripts/check-boot-purity.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['apps/honeycrisp/src/lib', 'apps/whispering/src/lib'];

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) yield* walk(path);
		else if (/\.ts$/.test(path) && !/\.test\.ts$/.test(path)) yield path;
	}
}

function stripComments(source: string): string {
	// Good enough for depth counting: removes block and line comments so a
	// brace inside a comment does not skew the depth.
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const findings: string[] = [];
for (const root of ROOTS) {
	for (const path of walk(root)) {
		const lines = stripComments(readFileSync(path, 'utf8')).split('\n');
		let depth = 0;
		lines.forEach((line, index) => {
			const atModuleScope = depth === 0;
			for (const character of line) {
				if (character === '{' || character === '(') depth += 1;
				if (character === '}' || character === ')') depth -= 1;
			}
			if (!atModuleScope) return;
			if (
				/^(export\s+)?(const|let|var)\s.*\bawait\s/.test(line) ||
				/^await\s/.test(line)
			) {
				findings.push(`${path}:${index + 1}  ${line.trim()}`);
			}
		});
	}
}

if (findings.length > 0) {
	console.error(
		`boot-purity: ${findings.length} top-level await(s) in app library modules`,
	);
	for (const finding of findings) console.error(`  ${finding}`);
	console.error(
		'  -> move the await behind the application-opening promise rendered by a mounted {#await} boundary;',
	);
	console.error(
		'     module evaluation must never reject (blank page before any error surface).',
	);
	process.exit(1);
}
console.log('boot-purity OK: no top-level awaits in app singleton modules.');
