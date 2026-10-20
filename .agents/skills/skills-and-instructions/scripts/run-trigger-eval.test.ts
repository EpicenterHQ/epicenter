/**
 * Trigger eval tests.
 *
 * Nothing here spawns the Claude CLI. `--live` costs quota and needs an
 * authenticated CLI, so the live path is covered the way `enlist-claude`
 * covers its runner: pin the arguments and the transcript parser, and leave
 * the call itself to a human who chose to pay for it.
 *
 * The corpus test is the anti-rot guard. A renamed or deleted skill silently
 * turns a case into a measurement of nothing, and only a check against the
 * real catalog notices.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	buildLiveArgs,
	compareStoredRun,
	type EvalCase,
	fingerprintInstructions,
	judge,
	type Observation,
	PROBE_ROUTER,
	parseLoadedSkills,
	partitionByRouter,
	runLexicalPass,
	summarize,
	validateCorpus,
} from './run-trigger-eval';
import { ALWAYS_ON_FILES, readSkillCatalog } from './skill-catalog';

const skillsDir = fileURLToPath(new URL('../..', import.meta.url));
const corpusPath = fileURLToPath(
	new URL('../evals/routing.json', import.meta.url),
);
const gateCorpusPath = fileURLToPath(
	new URL('../evals/always-on-gate.json', import.meta.url),
);
const runsDir = fileURLToPath(new URL('../evals/runs', import.meta.url));
const scriptPath = fileURLToPath(
	new URL('./run-trigger-eval.ts', import.meta.url),
);

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
	return {
		id: 'case-1',
		prompt: 'Run a collapse pass over this package.',
		anchors: ['collapse pass'],
		expect: 'collapse-pass',
		forbid: [],
		...overrides,
	};
}

describe('validateCorpus', () => {
	const known = new Set(['collapse-pass', 'refactoring']);

	test('accepts a well-formed case', () => {
		expect(validateCorpus([makeCase()], known)).toEqual([]);
	});

	test('rejects an anchor the prompt does not contain', () => {
		const problems = validateCorpus(
			[makeCase({ anchors: ['asymmetric win'] })],
			known,
		);
		expect(problems).toEqual([
			'case-1: anchor "asymmetric win" does not appear in the prompt',
		]);
	});

	test('rejects a case with no anchors', () => {
		expect(validateCorpus([makeCase({ anchors: [] })], known)).toEqual([
			'case-1: needs at least one anchor',
		]);
	});

	test('rejects an expect that names no skill', () => {
		expect(
			validateCorpus([makeCase({ expect: 'ghost-skill' })], known),
		).toEqual(['case-1: expect names no such skill: ghost-skill']);
	});

	test('rejects a forbid that names no skill', () => {
		expect(validateCorpus([makeCase({ forbid: ['ghost'] })], known)).toEqual([
			'case-1: forbid names no such skill: ghost',
		]);
	});

	test('rejects a skill that is both expected and forbidden', () => {
		const problems = validateCorpus(
			[makeCase({ forbid: ['collapse-pass'] })],
			known,
		);
		expect(problems).toContain(
			'case-1: collapse-pass is both expected and forbidden',
		);
	});

	test('rejects duplicate case ids', () => {
		expect(validateCorpus([makeCase(), makeCase()], known)).toEqual([
			'case-1: duplicate case id',
		]);
	});

	test('accepts a near-miss case with a null expectation', () => {
		expect(
			validateCorpus(
				[makeCase({ expect: null, forbid: ['collapse-pass'] })],
				known,
			),
		).toEqual([]);
	});
});

describe('runLexicalPass', () => {
	const skills = [
		{ name: 'owner', description: 'Use when the user says "collapse pass".' },
		{ name: 'rival', description: 'Use for a collapse pass over a diff.' },
		{
			name: 'router',
			description: 'Use for guards. For a collapse pass, use owner instead.',
		},
	];

	test('reports nothing when exactly the expected skill claims the anchor', () => {
		const findings = runLexicalPass(
			[makeCase({ expect: 'owner' })],
			[skills[0] as { name: string; description: string }],
		);
		expect(findings).toEqual([]);
	});

	test('reports an anchor no description claims', () => {
		const findings = runLexicalPass(
			[makeCase({ expect: 'owner' })],
			[skills[2] as { name: string; description: string }],
		);
		expect(findings.map((f) => f.kind)).toContain('NO_OWNER');
		expect(findings.find((f) => f.kind === 'NO_OWNER')?.detail).toContain(
			'disclaimed by router',
		);
	});

	test('a near-miss case wants its anchor unowned, so silence is the pass', () => {
		// expect: null means nothing should trigger. Reporting the unclaimed
		// phrase as a gap would make the passing state look like a defect.
		const findings = runLexicalPass(
			[makeCase({ expect: null })],
			[skills[2] as { name: string; description: string }],
		);
		expect(findings).toEqual([]);
	});

	test('a near-miss case still reports a skill that claims its anchor', () => {
		const findings = runLexicalPass(
			[makeCase({ expect: null, forbid: ['owner'] })],
			[skills[0] as { name: string; description: string }],
		);
		expect(findings.map((f) => f.kind)).toEqual(['FORBIDDEN_CLAIM']);
	});

	test('reports several claimants as ambiguous', () => {
		const findings = runLexicalPass([makeCase({ expect: 'owner' })], skills);
		expect(findings.map((f) => f.kind)).toEqual(['AMBIGUOUS']);
		expect(findings[0]?.detail).toBe('claimed by owner, rival');
	});

	test('reports the expected owner carrying no hook for its own phrase', () => {
		const findings = runLexicalPass(
			[makeCase({ expect: 'router' })],
			[skills[2] as { name: string; description: string }],
		);
		expect(findings.map((f) => f.kind)).toContain('UNOWNED_BY_EXPECTED');
		expect(findings[0]?.detail).toContain('routes this phrase away');
	});

	test('reports a forbidden skill that claims the anchor', () => {
		const findings = runLexicalPass(
			[makeCase({ expect: 'owner', forbid: ['rival'] })],
			skills,
		);
		expect(findings.map((f) => f.kind)).toContain('FORBIDDEN_CLAIM');
	});
});

describe('buildLiveArgs', () => {
	test('gives the probe only the Skill tool and never disables skills', () => {
		const args = buildLiveArgs({});

		expect(args).toContain('--tools');
		expect(args[args.indexOf('--tools') + 1]).toBe('Skill');
		expect(args).toContain('-p');
		expect(args).toContain('--no-session-persistence');
		expect(args.slice(args.indexOf('--output-format'))).toEqual([
			'--output-format',
			'stream-json',
			'--verbose',
		]);
		// --safe-mode disables skills, which would make every probe return NONE.
		expect(args).not.toContain('--safe-mode');
	});

	test('threads model and effort through for sweeps', () => {
		const args = buildLiveArgs({ model: 'claude-opus-5', effort: 'high' });

		expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5');
		expect(args[args.indexOf('--effort') + 1]).toBe('high');
	});

	test('omits model and effort when unset so the CLI default applies', () => {
		const args = buildLiveArgs({});

		expect(args).not.toContain('--model');
		expect(args).not.toContain('--effort');
	});
});

describe('parseLoadedSkills', () => {
	const event = (content: unknown) =>
		`${JSON.stringify({ type: 'assistant', message: { content } })}\n`;

	test('collects each skill the transcript shows being loaded', () => {
		const stream =
			event([
				{ type: 'tool_use', name: 'Skill', input: { skill: 'collapse-pass' } },
			]) + event([{ type: 'text', text: 'collapse-pass' }]);

		expect(parseLoadedSkills(stream)).toEqual(['collapse-pass']);
	});

	test('ignores tool uses that are not the Skill tool', () => {
		const stream = event([
			{ type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
		]);

		expect(parseLoadedSkills(stream)).toEqual([]);
	});

	test('deduplicates a skill loaded twice', () => {
		const block = { type: 'tool_use', name: 'Skill', input: { skill: 'git' } };

		expect(parseLoadedSkills(event([block]) + event([block]))).toEqual(['git']);
	});

	test('survives non-JSON lines in the stream', () => {
		const stream = `not json\n${event([
			{ type: 'tool_use', name: 'Skill', input: { skill: 'handoff' } },
		])}`;

		expect(parseLoadedSkills(stream)).toEqual(['handoff']);
	});

	test('returns nothing for a transcript that loaded no skill', () => {
		expect(parseLoadedSkills(event([{ type: 'text', text: 'NONE' }]))).toEqual(
			[],
		);
	});
});

describe('judge', () => {
	test('passes when the expected skill loaded', () => {
		expect(judge(makeCase(), ['collapse-pass']).verdict).toBe('pass');
	});

	test('fails when a different skill loaded', () => {
		const result = judge(makeCase(), ['refactoring']);

		expect(result.verdict).toBe('fail');
		expect(result.reason).toBe('expected collapse-pass, loaded refactoring');
	});

	test('fails on a forbidden skill even when the expected one also loaded', () => {
		const result = judge(makeCase({ forbid: ['refactoring'] }), [
			'collapse-pass',
			'refactoring',
		]);

		expect(result.verdict).toBe('fail');
		expect(result.reason).toContain('forbidden');
	});

	test('a near-miss case passes only when nothing loaded', () => {
		const nearMiss = makeCase({ expect: null, forbid: [] });

		expect(judge(nearMiss, []).verdict).toBe('pass');
		expect(judge(nearMiss, ['collapse-pass']).verdict).toBe('fail');
	});

	test('reports loading nothing when a skill was expected', () => {
		expect(judge(makeCase(), []).reason).toBe(
			'expected collapse-pass, loaded nothing',
		);
	});
});

describe('summarize', () => {
	const observation = (verdict: Observation['verdict']): Observation => ({
		loaded: [],
		verdict,
		reason: '',
	});

	test('all passing is a pass at 100%', () => {
		const result = summarize('c', [observation('pass'), observation('pass')]);

		expect(result.verdict).toBe('pass');
		expect(result.passRate).toBe(1);
	});

	test('none passing is a fail at 0%', () => {
		expect(summarize('c', [observation('fail')]).verdict).toBe('fail');
	});

	test('a mixed result is flaky rather than the last run winning', () => {
		const result = summarize('c', [
			observation('pass'),
			observation('fail'),
			observation('pass'),
		]);

		expect(result.verdict).toBe('flaky');
		expect(result.passRate).toBeCloseTo(2 / 3);
	});

	test('an errored run counts against the rate', () => {
		expect(
			summarize('c', [observation('pass'), observation('error')]).verdict,
		).toBe('flaky');
	});
});

describe('partitionByRouter', () => {
	test('an unmarked case defaults to the router --live can drive', () => {
		const { measurable, unmeasurable } = partitionByRouter([makeCase()]);

		expect(PROBE_ROUTER).toBe('claude');
		expect(measurable).toHaveLength(1);
		expect(unmeasurable).toEqual([]);
	});

	test('a Codex-routed case is held back rather than judged', () => {
		const { measurable, unmeasurable } = partitionByRouter([
			makeCase({ id: 'a' }),
			makeCase({ id: 'b', router: 'codex' }),
		]);

		expect(measurable.map((c) => c.id)).toEqual(['a']);
		expect(unmeasurable.map((c) => c.id)).toEqual(['b']);
	});
});

test('an unknown router is a corpus error', () => {
	const problems = validateCorpus(
		[makeCase({ router: 'gemini' as never })],
		new Set(['collapse-pass']),
	);

	expect(problems).toContain('case-1: unknown router: gemini');
});

test('the shipped corpus is valid against the real skill catalog', async () => {
	const corpus = JSON.parse(await readFile(corpusPath, 'utf8')) as {
		cases: EvalCase[];
	};
	const known = new Set((await readSkillCatalog(skillsDir)).map((s) => s.name));

	expect(validateCorpus(corpus.cases, known)).toEqual([]);
	expect(corpus.cases.length).toBeGreaterThan(0);
});

test('the always-on gate corpus is valid against the real skill catalog', async () => {
	const corpus = JSON.parse(await readFile(gateCorpusPath, 'utf8')) as {
		cases: EvalCase[];
	};
	const known = new Set((await readSkillCatalog(skillsDir)).map((s) => s.name));

	expect(validateCorpus(corpus.cases, known)).toEqual([]);
});

test('the gate corpus keeps both classes and its controls', async () => {
	const corpus = JSON.parse(await readFile(gateCorpusPath, 'utf8')) as {
		cases: (EvalCase & { cluster?: string })[];
	};

	// The result only means something as a contrast. Phrases a description owns
	// and phrases none does behave differently, and the controls are what shows
	// the arms differed by the gate rather than by probe drift.
	const clusters = new Set(corpus.cases.map((c) => c.cluster));
	expect(clusters).toEqual(new Set(['gate-orphan', 'gate-owned', 'control']));
	expect(corpus.cases.some((c) => c.expect === null)).toBe(true);
});

test('only Codex-side Claude consultation cases are marked unmeasurable', async () => {
	const corpus = JSON.parse(await readFile(corpusPath, 'utf8')) as {
		cases: EvalCase[];
	};
	const { unmeasurable } = partitionByRouter(corpus.cases);

	// This skill says in its own description that the active Codex-side agent
	// invokes it. The cases cover direction, review, and autonomous research.
	expect(unmeasurable.map((c) => c.expect)).toEqual([
		'consult-claude',
		'consult-claude',
		'consult-claude',
	]);
});

test('the default invocation stays offline and says so', () => {
	const result = spawnSync('bun', [scriptPath], { encoding: 'utf8' });

	expect(result.status).toBe(0);
	expect(result.stdout).toContain('not how a model routes');
	// No --live flag, so nothing may spawn the CLI.
	expect(result.stderr).toContain('Run --live to measure routing');
});

test('--strict turns the offline pass into a gate', () => {
	const result = spawnSync('bun', [scriptPath, '--strict'], {
		encoding: 'utf8',
	});

	expect(result.status).toBe(1);
});

describe('fingerprintInstructions', () => {
	async function scratch(files: Record<string, string>): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), 'trigger-eval-'));
		for (const [name, contents] of Object.entries(files))
			await writeFile(join(root, name), contents);
		return root;
	}

	test('records every always-on file that exists', async () => {
		const root = await scratch({
			'AGENTS.md': 'repo rules',
			'CLAUDE.md': '@AGENTS.md',
		});

		const { files } = await fingerprintInstructions(root);

		expect(files.map((f) => f.path)).toEqual([...ALWAYS_ON_FILES]);
		expect(files[0]?.bytes).toBe('repo rules'.length);
	});

	test('skips a file the repository does not have', async () => {
		const root = await scratch({ 'AGENTS.md': 'repo rules' });

		const { files } = await fingerprintInstructions(root);

		expect(files.map((f) => f.path)).toEqual(['AGENTS.md']);
	});

	test('gives the same digest for the same instructions', async () => {
		const one = await fingerprintInstructions(
			await scratch({ 'AGENTS.md': 'repo rules' }),
		);
		const two = await fingerprintInstructions(
			await scratch({ 'AGENTS.md': 'repo rules' }),
		);

		expect(one.digest).toBe(two.digest);
	});

	// The whole point: an edit to a routing sentence must make two result files
	// visibly incomparable, the way a model or effort change already does.
	test('changes the digest when a routing sentence changes', async () => {
		const before = await fingerprintInstructions(
			await scratch({
				'AGENTS.md': 'Review gates: load post-implementation-review.',
			}),
		);
		const after = await fingerprintInstructions(
			await scratch({ 'AGENTS.md': 'Review gates: load collapse-pass.' }),
		);

		expect(after.digest).not.toBe(before.digest);
	});
});

describe('compareStoredRun', () => {
	const current = {
		files: [{ path: 'AGENTS.md', bytes: 4, sha256: 'aa' }],
		digest: 'now',
	};

	test('a run produced under the same instructions is comparable', () => {
		expect(compareStoredRun({ instructions: { ...current } }, current)).toBe(
			'comparable',
		);
	});

	test('a run produced under different instructions is superseded', () => {
		const stored = { instructions: { ...current, digest: 'then' } };

		expect(compareStoredRun(stored, current)).toBe('superseded');
	});

	// A run recorded before the digest existed is not a failed run. It simply
	// cannot say which AGENTS.md produced its numbers, and reporting that as an
	// absence keeps it from being quoted as if it could.
	test('a run recorded before the digest existed is undigested', () => {
		expect(compareStoredRun({}, current)).toBe('undigested');
	});
});

test('--verify-runs reports every stored run against the working tree', () => {
	const result = spawnSync(
		'bun',
		['run', scriptPath, '--verify-runs', runsDir],
		{ encoding: 'utf8' },
	);

	// Every shipped run is listed exactly once, with a verdict and no numbers:
	// this flag answers whether a rate may be quoted, never what the rate was.
	const lines = result.stdout.trim().split('\n');
	const stored = readdirSync(runsDir).filter((n) => n.endsWith('.json'));
	expect(lines.length).toBe(stored.length);
	for (const line of lines)
		expect(line).toMatch(/^(comparable|superseded|undigested)\t.+\.json$/);
});

test('the shipped corpus covers both boundaries and both directions', async () => {
	const corpus = JSON.parse(await readFile(corpusPath, 'utf8')) as {
		cases: EvalCase[];
	};

	const clusters = new Set(corpus.cases.map((c) => c.cluster));
	expect(clusters).toEqual(new Set(['review', 'claude-consultation']));
	// A corpus with no near-miss cases only proves a skill can fire, never that
	// it stays quiet.
	expect(corpus.cases.some((c) => c.expect === null)).toBe(true);
	expect(corpus.cases.some((c) => c.expect !== null)).toBe(true);
});
