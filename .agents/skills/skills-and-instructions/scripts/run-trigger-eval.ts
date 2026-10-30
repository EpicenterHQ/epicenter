#!/usr/bin/env bun

/**
 * Run the trigger corpus against the skill library.
 *
 * Two modes, and the difference between them is the whole point of the script.
 *
 * The default mode is deterministic and offline. It reads what each skill's
 * `description` says about each anchor phrase and reports four conditions:
 * the expected owner carries no hook for its own phrase, nobody claims a
 * phrase some skill should own, several skills claim it, or a skill the case
 * forbids claims it.
 * These are facts about descriptions. They are *not* routing results. A
 * description can carry a near-miss clause that a substring scan cannot weigh
 * (`one-sentence-test` tells the agent to answer plain comprehension questions
 * directly, and no amount of lexical analysis sees that), and a model can route
 * correctly on intent with no lexical overlap at all. Treat this mode as a
 * cheap smoke test on description coverage, and never quote it as evidence
 * that routing works.
 *
 * `--live` measures routing. It spawns the Claude CLI once per case with the
 * Skill tool as its only tool, tells it to load the skill it would use and
 * stop, and records which skills it actually loaded. That is a real model
 * decision over the real descriptions. It is still a proxy rather than a
 * transcript of normal use: a session restricted to one tool and told not to
 * work is not the session the skill will really be selected in. It costs
 * quota, needs an authenticated CLI, and is opt-in for exactly those reasons.
 * The default test suite never invokes it.
 *
 * For a model or effort sweep, run `--live --model X --effort Y --out run-X-Y.json`
 * once per cell and diff the result files. The result file records the model,
 * the effort, and a digest of the always-on instructions it was produced under,
 * so a stale file cannot be mistaken for a fresh one.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	classifyClaim,
	readAlwaysOnInstructions,
	readSkillCatalog,
} from './skill-catalog';

export type InstructionFingerprint = {
	/** One entry per file that exists, in `ALWAYS_ON_FILES` order. */
	files: { path: string; bytes: number; sha256: string }[];
	/** Digest over every entry, so one field can decide comparability. */
	digest: string;
};

/**
 * Fingerprint the always-on instruction surface a live run routed under.
 *
 * `model` and `effort` are recorded because a result file produced under
 * different ones is not comparable. The always-on instructions are the third
 * such variable, and the only one that can change routing without touching a
 * single description: `AGENTS.md` names skills and conditions directly, and it
 * is loaded before any description is weighed. Until it is recorded, two
 * result files that disagree are indistinguishable from two runs of the same
 * configuration.
 *
 * This reads those files and never authors them. It is a digest, not a
 * declaration, so it cannot become a second place that says what routes what.
 */
export async function fingerprintInstructions(
	root: string,
): Promise<InstructionFingerprint> {
	const files = (await readAlwaysOnInstructions(root)).map(
		({ path, contents }) => ({
			path,
			bytes: Buffer.byteLength(contents),
			sha256: new Bun.CryptoHasher('sha256').update(contents).digest('hex'),
		}),
	);

	const combined = files.map((f) => `${f.path}:${f.sha256}`).join('\n');

	return {
		files,
		digest: new Bun.CryptoHasher('sha256').update(combined).digest('hex'),
	};
}

/** Whether a stored run's numbers still describe the working tree. */
export type RunComparability = 'comparable' | 'superseded' | 'undigested';

/**
 * Decide whether a stored run may still be quoted against the current tree.
 *
 * The proof this harness exists to serve is that always-on instructions cause
 * routes, so a stored rate is a fact about the `AGENTS.md` that produced it and
 * about no other one. `undigested` is its own verdict rather than a failure
 * because a run recorded before the digest existed is not wrong, it is simply
 * unable to answer the question.
 */
export function compareStoredRun(
	stored: { instructions?: InstructionFingerprint },
	current: InstructionFingerprint,
): RunComparability {
	if (!stored.instructions) return 'undigested';
	return stored.instructions.digest === current.digest
		? 'comparable'
		: 'superseded';
}

/**
 * Which agent's routing a case is about.
 *
 * `consult-claude` is written for a Codex session ("Ask Claude Code for
 * independent, context-rich design or implementation review"), so a
 * Claude probe answering it picks a neighbour every time. That is a category
 * error in the measurement, not a defect in the description, and marking the
 * case is how the harness says so instead of reporting a failure it cannot
 * justify.
 */
export type Router = 'claude' | 'codex';

export const ROUTERS: Router[] = ['claude', 'codex'];

/** `--live` drives the Claude CLI, so it can only measure Claude-routed cases. */
export const PROBE_ROUTER: Router = 'claude';

/** Split a batch into what this probe can measure and what it must not judge. */
export function partitionByRouter(cases: EvalCase[]): {
	measurable: EvalCase[];
	unmeasurable: EvalCase[];
} {
	return {
		measurable: cases.filter((c) => (c.router ?? 'claude') === PROBE_ROUTER),
		unmeasurable: cases.filter((c) => (c.router ?? 'claude') !== PROBE_ROUTER),
	};
}

export type EvalCase = {
	id: string;
	cluster?: string;
	prompt: string;
	anchors: string[];
	/**
	 * Phrases the prompt carries on purpose that belong to a *different* skill.
	 *
	 * A hard case is hard because a rival's trigger phrase is sitting in the
	 * prompt: "simplify this" next to nested ifs, "in one sentence" next to an
	 * authored rewrite. Those phrases are not anchors, because an anchor is a
	 * hook the expected owner should carry, and scanning them as one reports the
	 * boundary working as a defect. Listing them keeps the difficulty visible and
	 * pins it in place: the corpus validator fails if a rewrite drops one from
	 * the prompt, which would quietly make the `--live` case easier.
	 */
	distractors?: string[];
	/** Skill that should own this prompt, or null when nothing should trigger. */
	expect: string | null;
	forbid: string[];
	/** Defaults to `claude`, the only router `--live` can currently drive. */
	router?: Router;
	why?: string;
};

export type LexicalFinding = {
	kind: 'NO_OWNER' | 'UNOWNED_BY_EXPECTED' | 'AMBIGUOUS' | 'FORBIDDEN_CLAIM';
	caseId: string;
	anchor: string;
	detail: string;
};

const USAGE = `Usage: bun run .agents/skills/skills-and-instructions/scripts/run-trigger-eval.ts [options]

Default mode is offline and reports description coverage, not routing.

  --corpus <file>   corpus JSON (default: ../evals/routing.json)
  --verify-runs <dir>  report whether stored runs still describe this tree
  --case <id>       run one case (repeatable)
  --strict          exit 1 when the offline pass reports findings
  --json            emit results as JSON on stdout
  --live            spawn the Claude CLI per case and record real routing
  --model <name>    --live only: model to route under
  --effort <level>  --live only: low | medium | high | xhigh | max
  --limit <n>       --live only: stop after n cases (default: all)
  --runs <n>        --live only: probes per case, reported as a pass rate (default: 1)
  --timeout-ms <n>  --live only: per-probe timeout (default: 120000)
  --budget-ms <n>   --live only: whole-run wall clock ceiling (default: 900000)
  --out <file>      --live only: write the result file for sweeps
  --help            show this message

Exit codes: 0 clean, 1 findings (--strict or --live failures), 2 corpus or usage error.`;

const PROBE_INSTRUCTION = `You are a routing probe. Do not perform the task in the user message.
Load the one skill you would use with the Skill tool, then stop and reply with only that skill's name.
If no skill applies, load nothing and reply with only: NONE`;

/**
 * CLI arguments for one live routing probe.
 *
 * The Skill tool is the only tool, which both bounds the turn and makes the
 * transcript trivially parseable. `--safe-mode` is deliberately absent: it
 * disables skills, which would make every probe return NONE.
 */
export function buildLiveArgs(options: {
	model?: string;
	effort?: string;
}): string[] {
	return [
		'-p',
		'--tools',
		'Skill',
		'--permission-mode',
		'plan',
		'--no-session-persistence',
		'--no-chrome',
		'--append-system-prompt',
		PROBE_INSTRUCTION,
		'--output-format',
		'stream-json',
		'--verbose',
		...(options.model ? ['--model', options.model] : []),
		...(options.effort ? ['--effort', options.effort] : []),
	];
}

/** Pull every skill name the transcript shows the model loading. */
export function parseLoadedSkills(streamJson: string): string[] {
	const loaded: string[] = [];

	for (const line of streamJson.split('\n')) {
		if (!line.trim()) continue;

		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}

		const content = (event as { message?: { content?: unknown } } | undefined)
			?.message?.content;
		if (!Array.isArray(content)) continue;

		for (const block of content) {
			const b = block as { type?: string; name?: string; input?: unknown };
			if (b.type !== 'tool_use' || b.name !== 'Skill') continue;
			const input = b.input as { skill?: string; name?: string } | undefined;
			const skill = input?.skill ?? input?.name;
			if (skill && !loaded.includes(skill)) loaded.push(skill);
		}
	}

	return loaded;
}

/** Reject a corpus that cannot produce a meaningful result. */
export function validateCorpus(
	cases: EvalCase[],
	knownSkills: Set<string>,
): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();

	for (const testCase of cases) {
		const { id, prompt, anchors, expect, forbid } = testCase;

		if (!id) problems.push('a case is missing an id');
		if (seen.has(id)) problems.push(`${id}: duplicate case id`);
		seen.add(id);

		if (!prompt) problems.push(`${id}: missing prompt`);
		if (!Array.isArray(anchors) || anchors.length === 0)
			problems.push(`${id}: needs at least one anchor`);

		for (const anchor of anchors ?? []) {
			// An anchor the prompt does not contain measures nothing.
			if (!prompt?.toLowerCase().includes(anchor.toLowerCase()))
				problems.push(
					`${id}: anchor "${anchor}" does not appear in the prompt`,
				);
		}

		for (const distractor of testCase.distractors ?? []) {
			// A distractor that left the prompt took the case's difficulty with it.
			if (!prompt?.toLowerCase().includes(distractor.toLowerCase()))
				problems.push(
					`${id}: distractor "${distractor}" does not appear in the prompt`,
				);
			if ((anchors ?? []).includes(distractor))
				problems.push(
					`${id}: "${distractor}" is both an anchor and a distractor`,
				);
		}

		if (testCase.router !== undefined && !ROUTERS.includes(testCase.router))
			problems.push(`${id}: unknown router: ${testCase.router}`);

		if (expect !== null && !knownSkills.has(expect))
			problems.push(`${id}: expect names no such skill: ${expect}`);
		for (const name of forbid ?? [])
			if (!knownSkills.has(name))
				problems.push(`${id}: forbid names no such skill: ${name}`);
		if (expect !== null && (forbid ?? []).includes(expect))
			problems.push(`${id}: ${expect} is both expected and forbidden`);
	}

	return problems;
}

export function runLexicalPass(
	cases: EvalCase[],
	skills: { name: string; description: string }[],
): LexicalFinding[] {
	const findings: LexicalFinding[] = [];

	for (const testCase of cases) {
		for (const anchor of testCase.anchors) {
			const claimants = skills
				.filter((s) => classifyClaim(s.description, anchor) === 'claims')
				.map((s) => s.name);
			const disclaimers = skills
				.filter((s) => classifyClaim(s.description, anchor) === 'disclaims')
				.map((s) => s.name);

			const base = { caseId: testCase.id, anchor };

			if (testCase.expect !== null && !claimants.includes(testCase.expect)) {
				findings.push({
					...base,
					kind: 'UNOWNED_BY_EXPECTED',
					detail: disclaimers.includes(testCase.expect)
						? `${testCase.expect} routes this phrase away instead of claiming it`
						: `${testCase.expect} carries no lexical hook for this phrase`,
				});
			}

			if (claimants.length > 1) {
				findings.push({
					...base,
					kind: 'AMBIGUOUS',
					detail: `claimed by ${claimants.join(', ')}`,
				});
			} else if (claimants.length === 0 && testCase.expect !== null) {
				// A case expecting no skill *wants* its phrase unowned, so an
				// unclaimed phrase there is the passing state rather than a gap.
				// Only a case naming an owner can be missing one. Ambiguity and
				// forbidden claims are still reported for near misses, because
				// over-claiming is how a near miss actually fails.
				findings.push({
					...base,
					kind: 'NO_OWNER',
					detail:
						disclaimers.length > 0
							? `no skill claims it; disclaimed by ${disclaimers.join(', ')}`
							: 'no skill description mentions it',
				});
			}

			for (const name of testCase.forbid) {
				if (claimants.includes(name))
					findings.push({
						...base,
						kind: 'FORBIDDEN_CLAIM',
						detail: `${name} claims a phrase this case says it must not answer`,
					});
			}
		}
	}

	return findings;
}

export type Observation = {
	loaded: string[];
	verdict: 'pass' | 'fail' | 'error';
	reason: string;
};

export type CaseResult = {
	caseId: string;
	/** Fraction of runs that passed, so a flaky trigger is visible as a rate. */
	passRate: number;
	verdict: 'pass' | 'flaky' | 'fail';
	runs: Observation[];
};

/** Decide one run's verdict from the skills the transcript shows loading. */
export function judge(testCase: EvalCase, loaded: string[]): Observation {
	const forbidden = loaded.filter((name) => testCase.forbid.includes(name));
	if (forbidden.length > 0)
		return {
			loaded,
			verdict: 'fail',
			reason: `loaded forbidden skill(s): ${forbidden.join(', ')}`,
		};

	if (testCase.expect === null)
		return loaded.length === 0
			? { loaded, verdict: 'pass', reason: 'loaded nothing' }
			: {
					loaded,
					verdict: 'fail',
					reason: `expected no skill, loaded ${loaded.join(', ')}`,
				};

	return loaded.includes(testCase.expect)
		? { loaded, verdict: 'pass', reason: `loaded ${testCase.expect}` }
		: {
				loaded,
				verdict: 'fail',
				reason: `expected ${testCase.expect}, loaded ${loaded.join(', ') || 'nothing'}`,
			};
}

/**
 * Collapse repeated runs into one verdict.
 *
 * Routing varies between runs, so a case that passes twice and fails once is
 * neither a pass nor a failure. `flaky` keeps that distinction visible instead
 * of letting the last run decide.
 */
export function summarize(caseId: string, runs: Observation[]): CaseResult {
	const passed = runs.filter((r) => r.verdict === 'pass').length;
	const passRate = runs.length === 0 ? 0 : passed / runs.length;

	return {
		caseId,
		passRate,
		verdict: passRate === 1 ? 'pass' : passRate === 0 ? 'fail' : 'flaky',
		runs,
	};
}

async function probe(
	testCase: EvalCase,
	options: { model?: string; effort?: string; timeoutMs: number; cwd: string },
): Promise<Observation> {
	const { CLAUDECODE: _ignored, ...env } = process.env;
	const child: ChildProcess = spawn('claude', buildLiveArgs(options), {
		cwd: options.cwd,
		env,
		stdio: ['pipe', 'pipe', 'pipe'],
	});

	let stdout = '';
	let stderr = '';
	child.stdout?.on('data', (chunk) => {
		stdout += chunk;
	});
	child.stderr?.on('data', (chunk) => {
		stderr += chunk;
	});
	child.stdin?.on('error', () => {
		// The child exited before reading the prompt; the close handler reports it.
	});
	child.stdin?.end(testCase.prompt);

	// A hung probe must end the probe, never the run. Recording the timeout as
	// its own reason keeps it distinguishable from a CLI that failed fast.
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill('SIGKILL');
	}, options.timeoutMs);
	const code = await new Promise<number | null>((done) => {
		child.once('error', () => done(null));
		child.once('close', done);
	});
	clearTimeout(timer);

	if (timedOut)
		return {
			loaded: [],
			verdict: 'error',
			reason: `timed out after ${options.timeoutMs}ms; raise --timeout-ms or drop the case`,
		};

	if (code !== 0)
		return {
			loaded: [],
			verdict: 'error',
			reason: `claude exited ${code}: ${stderr.trim().slice(0, 200)}`,
		};

	return judge(testCase, parseLoadedSkills(stdout));
}

function flagValue(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : argv[index + 1];
}

/** Every value following a repeatable flag, e.g. `--case a --case b`. */
function flagValues(argv: string[], flag: string): string[] {
	return argv.flatMap((arg, index) =>
		arg === flag && argv[index + 1] !== undefined
			? [argv[index + 1] as string]
			: [],
	);
}

if (import.meta.main) {
	const argv = process.argv.slice(2);

	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(USAGE);
		process.exit(0);
	}

	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const skillsDir = join(scriptDir, '..', '..');
	const repoRoot = resolve(skillsDir, '..', '..');

	// Answering "may I still quote this number?" needs no corpus and no quota,
	// so it runs before the corpus is even loaded.
	const verifyDir = flagValue(argv, '--verify-runs');
	if (verifyDir !== undefined) {
		const current = await fingerprintInstructions(repoRoot);
		const files = (await readdir(resolve(verifyDir)))
			.filter((name) => name.endsWith('.json'))
			.sort();

		let stale = 0;
		for (const name of files) {
			const stored = (await Bun.file(resolve(verifyDir, name)).json()) as {
				instructions?: InstructionFingerprint;
			};
			const verdict = compareStoredRun(stored, current);
			if (verdict !== 'comparable') stale++;
			console.log(`${verdict}\t${name}`);
		}

		console.error(
			`run-trigger-eval: ${files.length - stale}/${files.length} run(s) comparable against instructions=${current.digest.slice(0, 12)}.`,
		);
		process.exit(stale > 0 ? 1 : 0);
	}

	const corpusPath = resolve(
		flagValue(argv, '--corpus') ??
			join(scriptDir, '..', 'evals', 'routing.json'),
	);

	const corpusFile = Bun.file(corpusPath);
	if (!(await corpusFile.exists())) {
		console.error(`run-trigger-eval: no corpus at ${corpusPath}`);
		process.exit(2);
	}

	const corpus = (await corpusFile.json()) as { cases: EvalCase[] };
	const skills = await readSkillCatalog(skillsDir);
	const known = new Set(skills.map((s) => s.name));

	const problems = validateCorpus(corpus.cases, known);
	if (problems.length > 0) {
		console.error('run-trigger-eval: corpus is invalid.');
		for (const problem of problems) console.error(`  ${problem}`);
		process.exit(2);
	}

	const wanted = flagValues(argv, '--case');
	const selected =
		wanted.length === 0
			? corpus.cases
			: corpus.cases.filter((c) => wanted.includes(c.id));

	if (selected.length === 0) {
		console.error('run-trigger-eval: --case matched nothing.');
		process.exit(2);
	}

	if (!argv.includes('--live')) {
		const findings = runLexicalPass(selected, skills);

		if (argv.includes('--json')) {
			console.log(
				JSON.stringify(
					{ mode: 'lexical', cases: selected.length, findings },
					null,
					2,
				),
			);
		} else {
			console.log(
				`# description coverage over ${selected.length} case(s) and ${skills.length} skills`,
			);
			console.log(
				'# this reports what descriptions say, not how a model routes\n',
			);
			for (const { kind, caseId, anchor, detail } of findings)
				console.log(`${kind}\t${caseId}\t"${anchor}"\t${detail}`);
			if (findings.length === 0) console.log('(no findings)');
		}

		console.error(
			`run-trigger-eval: ${findings.length} coverage finding(s). Run --live to measure routing.`,
		);
		process.exit(argv.includes('--strict') && findings.length > 0 ? 1 : 0);
	}

	if (!Bun.which('claude')) {
		console.error(
			'run-trigger-eval: --live needs an authenticated `claude` on PATH. The default offline pass needs no credentials.',
		);
		process.exit(2);
	}

	const model = flagValue(argv, '--model');
	const effort = flagValue(argv, '--effort');
	const limit = Number(flagValue(argv, '--limit') ?? selected.length);
	const timeoutMs = Number(flagValue(argv, '--timeout-ms') ?? 120_000);
	const budgetMs = Number(flagValue(argv, '--budget-ms') ?? 900_000);
	const runsPerCase = Number(flagValue(argv, '--runs') ?? 1);
	const cwd = repoRoot;

	// Cases written for a Codex session cannot be judged by a Claude probe.
	// Dropping them silently would manufacture failures, so name them instead.
	const { measurable, unmeasurable } = partitionByRouter(
		selected.slice(0, limit),
	);
	const batch = measurable;

	if (measurable.length + unmeasurable.length < selected.length)
		console.error(
			`run-trigger-eval: --limit ${limit} drops ${selected.length - measurable.length - unmeasurable.length} case(s) from this run.`,
		);

	for (const testCase of unmeasurable)
		console.error(
			`run-trigger-eval: NOT MEASURED ${testCase.id}: routed by ${testCase.router}, and --live only drives ${PROBE_ROUTER}.`,
		);

	const startedAt = Date.now();
	const results: CaseResult[] = [];
	let budgetExhausted = false;

	for (const [index, testCase] of batch.entries()) {
		if (Date.now() - startedAt > budgetMs) {
			budgetExhausted = true;
			console.error(
				`run-trigger-eval: --budget-ms ${budgetMs} exhausted; ${batch.length - index} case(s) never ran.`,
			);
			break;
		}

		const runs: Observation[] = [];
		for (let attempt = 1; attempt <= runsPerCase; attempt++) {
			console.error(
				`run-trigger-eval: [${index + 1}/${batch.length}] ${testCase.id} run ${attempt}/${runsPerCase}`,
			);
			runs.push(await probe(testCase, { model, effort, timeoutMs, cwd }));
		}
		results.push(summarize(testCase.id, runs));
	}

	const instructions = await fingerprintInstructions(cwd);

	const run = {
		mode: 'live' as const,
		model: model ?? '(cli default)',
		effort: effort ?? '(cli default)',
		runsPerCase,
		budgetExhausted,
		notMeasured: unmeasurable.map((c) => ({ id: c.id, router: c.router })),
		corpus: corpusPath,
		instructions,
		results,
	};

	if (argv.includes('--json')) console.log(JSON.stringify(run, null, 2));
	else
		for (const { verdict, caseId, passRate, runs } of results)
			console.log(
				`${verdict.toUpperCase()}\t${caseId}\t${Math.round(passRate * 100)}%\t${runs
					.map((r) => `[${r.loaded.join(', ')}]`)
					.join(' ')}`,
			);

	const out = flagValue(argv, '--out');
	if (out) {
		await writeFile(resolve(out), `${JSON.stringify(run, null, 2)}\n`);
		console.error(`run-trigger-eval: wrote ${resolve(out)}`);
	}

	const failed = results.filter((r) => r.verdict !== 'pass');
	console.error(
		`run-trigger-eval: ${results.length - failed.length}/${results.length} clean over ${runsPerCase} run(s) each, model=${run.model} effort=${run.effort}, instructions=${instructions.digest.slice(0, 12)} (${instructions.files.map((f) => f.path).join(', ') || 'none'}).`,
	);
	// An exhausted budget is an incomplete run, not a clean one.
	process.exit(failed.length > 0 || budgetExhausted ? 1 : 0);
}
