#!/usr/bin/env bun

/**
 * Report every skill description that mentions one trigger phrase.
 *
 * The `phrase -> skill/SKILL.md` line format and the exit codes are the
 * contract `references/composition-audit.md` documents; do not change them.
 *
 * It counts claimants rather than mentions because resolving a contested
 * phrase *creates* a second mention. The fix for two skills claiming
 * "simplify this" is for one of them to say "use collapse-pass instead", and a
 * detector counting mentions would call that resolved state a collision, which
 * teaches the reader to ignore its exit code. Every mention is still listed:
 * knowing who routes a phrase away is most of why you ran this.
 *
 * `--explain` annotates each line with `[claims]` or `[disclaims]`. It only
 * surfaces the classification the verdict already runs on, so it cannot change
 * a result.
 *
 * Always-on hits are reported additively, on stderr, because a skill
 * description is not the only thing that routes. `AGENTS.md` loads before any
 * description is weighed and names skills outright, and a live probe obeys it:
 * an `AGENTS.md` sentence sending overflow reports to `documentation` beat
 * `styling`'s own description 3 times out of 3. A phrase claimed by one
 * description and by `AGENTS.md` has two claimants while this script counts
 * one, which is exactly the collision it exists to catch. The report goes to
 * stderr so the stdout contract above is untouched.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	classifyClaim,
	readAlwaysOnInstructions,
	readSkillCatalog,
} from './skill-catalog';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultSkillsDir = join(scriptDir, '..', '..');
const repoRoot = join(scriptDir, '..', '..', '..', '..');

const USAGE = `Usage: bun run .agents/skills/skills-and-instructions/scripts/audit-routing-collisions.ts [--explain] "trigger phrase"

Reports which skill descriptions mention the phrase.

  --explain   annotate each hit as [claims] or [disclaims]

Exit codes: 0 exactly one claimant, 1 zero or multiple claimants, 2 usage error.`;

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
	console.log(USAGE);
	process.exit(0);
}

const isExplaining = argv.includes('--explain');
const phrase = argv
	.filter((arg) => arg !== '--explain')
	.join(' ')
	.trim();

if (!phrase) {
	console.error(USAGE);
	process.exit(2);
}

const skills = await readSkillCatalog(defaultSkillsDir);
const matches = skills
	.map((skill) => ({
		skill,
		verdict: classifyClaim(skill.description, phrase),
	}))
	.filter(({ verdict }) => verdict !== 'absent');

for (const { skill, verdict } of matches) {
	const annotation = isExplaining ? ` [${verdict}]` : '';
	console.log(`${phrase} -> ${skill.name}/SKILL.md${annotation}`);
}

for (const { path, contents } of await readAlwaysOnInstructions(repoRoot)) {
	contents.split(/\r?\n/).forEach((line, index) => {
		if (!line.toLowerCase().includes(phrase.toLowerCase())) return;
		console.error(
			`also claimed by ${path}:${index + 1}, which loads before any description`,
		);
	});
}

const claimants = matches.filter(({ verdict }) => verdict === 'claims');

if (claimants.length === 1) {
	process.exit(0);
}

if (claimants.length === 0) {
	// A phrase every mention routes away is the worse of the two failures: it
	// reads as owned until you notice nobody accepts it.
	console.error(
		matches.length === 0
			? `No skill description claims "${phrase}".`
			: `No skill description claims "${phrase}"; ${matches.length} route it elsewhere. Give it an owner or stop advertising it.`,
	);
	process.exit(1);
}

console.error(
	`Routing collision: ${claimants.length} skill descriptions claim "${phrase}": ${claimants
		.map(({ skill }) => skill.name)
		.join(', ')}.`,
);
process.exit(1);
