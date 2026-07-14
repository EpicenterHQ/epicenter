/**
 * Application data version lock gate tests.
 *
 * Runs the CLI against throwaway git repositories so both Git-history
 * immutability and source-to-lock drift checks exercise their real process and
 * filesystem boundaries.
 *
 * Key behaviors:
 * - Published lock paths and entries are append-only from an exact base SHA
 * - Only framework-minted candidates can reproduce locked entries
 * - Every tracked lock has non-optional convention-owned source coverage
 * - Write mode creates or appends locks but never rewrites published entries
 */

import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { field } from '../packages/field/src/index.js';
import { APPLICATION_DATA_VERSION_LOCK_FORMAT } from '../packages/workspace/src/sqlite/data-version.js';
import {
	defineKv,
	defineTable,
	defineWorkspace,
} from '../packages/workspace/src/sqlite/definition.js';

const scriptPath = fileURLToPath(
	new URL('./check-application-data-version-locks.ts', import.meta.url),
);
const definitionModuleUrl = new URL(
	'../packages/workspace/src/sqlite/definition.js',
	import.meta.url,
).href;
const fieldModuleUrl = new URL(
	'../packages/field/src/index.js',
	import.meta.url,
).href;
const lockPath = 'app/data-version-lock.json';

type CandidateVariant = 'base' | 'plane-drift' | 'schema-drift';

function candidateFor(dataVersion: number, variant: CandidateVariant = 'base') {
	if (variant === 'schema-drift') {
		const rows = defineTable({
			fields: { id: field.string(), title: field.string() },
		});
		return defineWorkspace({
			appId: 'fixture',
			dataVersion,
			tables: { rows },
		});
	}
	const rows = defineTable({
		fields: { id: field.string() },
	});
	return defineWorkspace({
		appId: 'fixture',
		dataVersion,
		tables: { rows },
		...(variant === 'plane-drift'
			? { kv: { preference: defineKv(field.string(), () => '') } }
			: {}),
	});
}

function version(dataVersion: number) {
	return candidateFor(dataVersion).proposedLockEntry;
}

type Entry = ReturnType<typeof version>;

function lock(versions: Entry[]) {
	return {
		format: APPLICATION_DATA_VERSION_LOCK_FORMAT,
		appId: 'fixture',
		versions,
	};
}

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function writeJson(cwd: string, relativePath: string, value: unknown): void {
	const absolutePath = path.join(cwd, relativePath);
	mkdirSync(path.dirname(absolutePath), { recursive: true });
	writeFileSync(absolutePath, `${JSON.stringify(value, null, '\t')}\n`);
}

function writeCandidate(
	cwd: string,
	dataVersion: number,
	variant: CandidateVariant = 'base',
	extraExport = '',
): string {
	const candidatePath = `app/src/versions/v${dataVersion}/workspace.ts`;
	const absolutePath = path.join(cwd, candidatePath);
	mkdirSync(path.dirname(absolutePath), { recursive: true });
	writeFileSync(
		absolutePath,
		`import { field } from ${JSON.stringify(fieldModuleUrl)};
import { defineKv, defineTable, defineWorkspace } from ${JSON.stringify(definitionModuleUrl)};

const rows = defineTable({
	fields: ${
		variant === 'schema-drift'
			? '{ id: field.string(), title: field.string() }'
			: '{ id: field.string() }'
	},
});

export const workspaceCandidate = defineWorkspace({
	appId: 'fixture',
	dataVersion: ${dataVersion},
	tables: { rows },${
		variant === 'plane-drift'
			? "\n\tkv: { preference: defineKv(field.string(), () => '') },"
			: ''
	}
});
${extraExport}`,
	);
	return candidatePath;
}

function candidatePath(dataVersion: number): string {
	return `app/src/versions/v${dataVersion}/workspace.ts`;
}

function setup({
	initialVersions = [version(1)],
	withLock = true,
}: {
	initialVersions?: Entry[];
	withLock?: boolean;
} = {}) {
	const cwd = mkdtempSync(path.join(os.tmpdir(), 'data-version-locks-'));
	git(cwd, ['init', '-q', '-b', 'main']);
	git(cwd, ['config', 'user.email', 'fixture@test.local']);
	git(cwd, ['config', 'user.name', 'Fixture']);
	git(cwd, ['config', 'commit.gpgsign', 'false']);
	mkdirSync(path.join(cwd, 'app'), { recursive: true });
	for (const entry of initialVersions) {
		writeCandidate(cwd, entry.dataVersion);
	}
	if (withLock) writeJson(cwd, lockPath, lock(initialVersions));
	git(cwd, ['add', 'app']);
	git(cwd, ['commit', '-q', '-m', 'fixture base']);
	const base = git(cwd, ['rev-parse', 'HEAD']);
	return { cwd, base };
}

function run(
	cwd: string,
	args: string[],
	environment: Record<string, string> = {},
) {
	const env = { ...process.env };
	delete env.CI;
	delete env.DATA_VERSION_LOCK_BASE;
	Object.assign(env, environment);
	const result = spawnSync('bun', [scriptPath, ...args], {
		cwd,
		encoding: 'utf8',
		env,
	});
	return {
		code: result.status,
		output: `${result.stdout}${result.stderr}`,
	};
}

function sourceArgs(candidatePaths: string[], mode = '--check'): string[] {
	return [
		mode,
		'--lock',
		lockPath,
		...candidatePaths.flatMap((candidatePath) => [
			'--candidate',
			candidatePath,
		]),
	];
}

function withRepo(
	callback: (fixture: ReturnType<typeof setup>) => void,
	options?: Parameters<typeof setup>[0],
): void {
	const fixture = setup(options);
	try {
		callback(fixture);
	} finally {
		rmSync(fixture.cwd, { recursive: true, force: true });
	}
}

// ============================================================================
// Source drift and writes
// ============================================================================

test('check accepts full candidates whose generated entries exactly match the lock', () => {
	withRepo(({ cwd }) => {
		const result = run(cwd, sourceArgs([candidatePath(1)]));
		expect(result.code).toBe(0);
		expect(result.output).toContain('sources match');
	});
});

test('check rejects candidate durable-plane drift without changing the lock', () => {
	withRepo(({ cwd }) => {
		writeCandidate(cwd, 1, 'plane-drift');
		const before = readFileSync(path.join(cwd, lockPath), 'utf8');
		const result = run(cwd, sourceArgs([candidatePath(1)]));
		expect(result.code).toBe(1);
		expect(result.output).toContain('drifted from the committed lock');
		expect(readFileSync(path.join(cwd, lockPath), 'utf8')).toBe(before);
	});
});

test('check rejects a candidate module with another export', () => {
	withRepo(({ cwd }) => {
		writeCandidate(cwd, 1, 'base', 'export const secondOwner = true;\n');
		const result = run(cwd, sourceArgs([candidatePath(1)]));
		expect(result.code).toBe(1);
		expect(result.output).toContain('must export only workspaceCandidate');
	});
});

test('check rejects a forged candidate with a valid proposed lock entry', () => {
	withRepo(({ cwd }) => {
		const forgedPath = candidatePath(1);
		writeFileSync(
			path.join(cwd, forgedPath),
			`export const workspaceCandidate = ${JSON.stringify({
				appId: 'fixture',
				proposedLockEntry: version(1),
			})};\n`,
		);
		const result = run(cwd, sourceArgs([forgedPath]));
		expect(result.code).toBe(1);
		expect(result.output).toContain(
			'Workspace candidate must be returned by defineWorkspace()',
		);
	});
});

test('check requires every published version candidate', () => {
	withRepo(
		({ cwd }) => {
			const result = run(cwd, sourceArgs([candidatePath(1)]));
			expect(result.code).toBe(1);
			expect(result.output).toContain(
				'candidate for a published version is missing',
			);
		},
		{ initialVersions: [version(1), version(2)] },
	);
});

test('check reports an unlocked tail and performs no write', () => {
	withRepo(({ cwd }) => {
		writeCandidate(cwd, 2);
		const before = readFileSync(path.join(cwd, lockPath), 'utf8');
		const result = run(cwd, sourceArgs([candidatePath(1), candidatePath(2)]));
		expect(result.code).toBe(1);
		expect(result.output).toContain('not recorded');
		expect(readFileSync(path.join(cwd, lockPath), 'utf8')).toBe(before);
	});
});

test('write creates an absent lock from explicit candidates', () => {
	withRepo(
		({ cwd }) => {
			const result = run(cwd, sourceArgs([candidatePath(1)], '--write'));
			expect(result.code).toBe(0);
			expect(
				JSON.parse(readFileSync(path.join(cwd, lockPath), 'utf8')),
			).toEqual(lock([version(1)]));
		},
		{ initialVersions: [version(1)], withLock: false },
	);
});

test('write appends only a new candidate tail', () => {
	withRepo(({ cwd }) => {
		writeCandidate(cwd, 2);
		const result = run(
			cwd,
			sourceArgs([candidatePath(1), candidatePath(2)], '--write'),
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(readFileSync(path.join(cwd, lockPath), 'utf8'))).toEqual(
			lock([version(1), version(2)]),
		);
	});
});

test('write refuses existing-entry drift and leaves the lock byte-for-byte unchanged', () => {
	withRepo(({ cwd }) => {
		writeCandidate(cwd, 1, 'schema-drift');
		const before = readFileSync(path.join(cwd, lockPath), 'utf8');
		const result = run(cwd, sourceArgs([candidatePath(1)], '--write'));
		expect(result.code).toBe(1);
		expect(result.output).toContain('drifted from the committed lock');
		expect(readFileSync(path.join(cwd, lockPath), 'utf8')).toBe(before);
	});
});

// ============================================================================
// Generic history gate
// ============================================================================

test('history check accepts only an appended lock tail', () => {
	withRepo(({ cwd, base }) => {
		const secondCandidate = writeCandidate(cwd, 2);
		git(cwd, ['add', secondCandidate]);
		writeJson(cwd, lockPath, lock([version(1), version(2)]));
		const result = run(cwd, ['--check-history', '--base', base]);
		expect(result.code).toBe(0);
		expect(result.output).toContain(`preserve base ${base}`);
	});
});

test('history check rejects a changed published entry', () => {
	withRepo(({ cwd, base }) => {
		const baseline = version(1);
		writeJson(
			cwd,
			lockPath,
			lock([
				{
					...baseline,
					recordsSchemaHash: `sha256:${'f'.repeat(64)}`,
				},
			]),
		);
		const result = run(cwd, ['--check-history', '--base', base]);
		expect(result.code).toBe(1);
		expect(result.output).toContain('entry 1 changed or moved');
	});
});

test('history check rejects removed published entries', () => {
	withRepo(
		({ cwd, base }) => {
			writeJson(cwd, lockPath, lock([version(1)]));
			const result = run(cwd, ['--check-history', '--base', base]);
			expect(result.code).toBe(1);
			expect(result.output).toContain('entries were removed');
		},
		{ initialVersions: [version(1), version(2)] },
	);
});

test('history check rejects reordered published entries', () => {
	withRepo(
		({ cwd, base }) => {
			writeJson(cwd, lockPath, lock([version(2), version(1)]));
			const result = run(cwd, ['--check-history', '--base', base]);
			expect(result.code).toBe(1);
			expect(result.output).toContain('strictly increasing');
		},
		{ initialVersions: [version(1), version(2)] },
	);
});

test('history check rejects deletion of a published lock', () => {
	withRepo(({ cwd, base }) => {
		git(cwd, ['rm', '-q', lockPath]);
		const result = run(cwd, ['--check-history', '--base', base]);
		expect(result.code).toBe(1);
		expect(result.output).toContain('was deleted or renamed');
	});
});

test('history check rejects rename of a published lock', () => {
	withRepo(({ cwd, base }) => {
		mkdirSync(path.join(cwd, 'renamed'));
		git(cwd, ['mv', lockPath, 'renamed/data-version-lock.json']);
		const result = run(cwd, ['--check-history', '--base', base]);
		expect(result.code).toBe(1);
		expect(result.output).toContain('was deleted or renamed');
	});
});

test('history check validates the exact current artifact shape', () => {
	withRepo(({ cwd }) => {
		writeJson(cwd, lockPath, { ...lock([version(1)]), mutable: true });
		const result = run(cwd, ['--check-history']);
		expect(result.code).toBe(1);
		expect(result.output).toContain('Invalid application data version lock');
	});
});

test('history check rejects a tracked lock without tracked source coverage', () => {
	withRepo(({ cwd }) => {
		git(cwd, ['rm', '-q', candidatePath(1)]);
		const result = run(cwd, ['--check-history']);
		expect(result.code).toBe(1);
		expect(result.output).toContain('has no tracked source candidates');
	});
});

test('history check rejects tracked source drift without a package script', () => {
	withRepo(({ cwd }) => {
		writeCandidate(cwd, 1, 'schema-drift');
		git(cwd, ['add', candidatePath(1)]);
		const result = run(cwd, ['--check-history']);
		expect(result.code).toBe(1);
		expect(result.output).toContain(
			'does not exactly match its source candidates',
		);
	});
});

test('history check supports a root-level tracked lock and source convention', () => {
	withRepo(({ cwd }) => {
		git(cwd, ['mv', lockPath, 'data-version-lock.json']);
		git(cwd, ['mv', 'app/src', 'src']);
		const result = run(cwd, ['--check-history']);
		expect(result.code).toBe(0);
		expect(result.output).toContain('1 tracked lock(s) match sources');
	});
});

test('history check validates the exact base artifact shape', () => {
	withRepo(({ cwd }) => {
		writeJson(cwd, lockPath, { ...lock([version(1)]), mutable: true });
		git(cwd, ['add', lockPath]);
		git(cwd, ['commit', '-q', '-m', 'invalid base shape']);
		const invalidBase = git(cwd, ['rev-parse', 'HEAD']);
		writeJson(cwd, lockPath, lock([version(1)]));
		const result = run(cwd, ['--check-history', '--base', invalidBase]);
		expect(result.code).toBe(1);
		expect(result.output).toContain('Base data version lock');
		expect(result.output).toContain(
			'not a valid application data version lock',
		);
	});
});

test('history check accepts DATA_VERSION_LOCK_BASE', () => {
	withRepo(({ cwd, base }) => {
		const result = run(cwd, ['--check-history'], {
			DATA_VERSION_LOCK_BASE: base,
		});
		expect(result.code).toBe(0);
		expect(result.output).toContain(`preserve base ${base}`);
	});
});

test('history check rejects a symbolic base ref', () => {
	withRepo(({ cwd }) => {
		const result = run(cwd, ['--check-history', '--base', 'main']);
		expect(result.code).toBe(1);
		expect(result.output).toContain('must be an exact full commit SHA');
	});
});

test('CI refuses to run without an explicit base SHA', () => {
	withRepo(({ cwd }) => {
		const result = run(cwd, ['--check-history'], { CI: 'true' });
		expect(result.code).toBe(1);
		expect(result.output).toContain('CI requires --base');
	});
});
