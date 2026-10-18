/**
 * API path gate tests.
 *
 * These drive the script against throwaway git repos because the gate's
 * contract is a filesystem scan rooted at `git rev-parse --show-toplevel`.
 * Each fixture exercises one filter of the ported grep pipeline: the match
 * pattern, the allowlisted vendored mirrors, the comment-line exclusion, and
 * the file/directory exclusions.
 */

import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(
	new URL('./check-api-paths.ts', import.meta.url),
);

function makeRepo(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'api-paths-'));
	execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
	return dir;
}

function write(dir: string, rel: string, body: string): void {
	const target = path.join(dir, rel);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, body);
}

function runCheck(dir: string): { status: number | null; output: string } {
	const result = spawnSync('bun', ['run', scriptPath], {
		cwd: dir,
		encoding: 'utf8',
	});
	return { status: result.status, output: result.stdout + result.stderr };
}

test('flags a hardcoded API path literal with file and line', () => {
	const dir = makeRepo();
	try {
		write(dir, 'packages/thing/src/client.ts', "const url = '/api/session';\n");
		const { status, output } = runCheck(dir);
		expect(status).toBe(1);
		expect(output).toContain('packages/thing/src/client.ts:1:');
		expect(output).toContain('::error::Hardcoded API path literal found');
		expect(output).toContain('API_ROUTES');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('passes allowlisted mirrors, comments, tests, and excluded dirs', () => {
	const dir = makeRepo();
	try {
		// Source-of-truth files are allowed verbatim.
		write(
			dir,
			'packages/constants/src/api-routes.ts',
			"export const SESSION = '/api/session';\n",
		);
		// Comment lines are prose, not constructions.
		write(
			dir,
			'apps/web/src/notes.ts',
			" * hits '/api/session' eventually\n// see '/api/ai' for details\n",
		);
		// Test files may reference paths verbatim.
		write(dir, 'packages/thing/src/client.test.ts', "mock('/api/session');\n");
		// Build output and dependencies are never scanned.
		write(
			dir,
			'packages/thing/node_modules/dep/index.ts',
			"fetch('/api/session');\n",
		);
		// A longer lowercase segment is a different route, not a match.
		write(
			dir,
			'apps/web/src/other.ts',
			"const fine = '/api/sessions-of-mine';\n",
		);
		const { status, output } = runCheck(dir);
		expect(output).toContain('no hardcoded API path literals');
		expect(status).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('former OAuth grant callback paths are outside the API path gate', () => {
	const dir = makeRepo();
	try {
		write(
			dir,
			'apps/web/src/login.ts',
			"window.location.href = '/auth/oauth2/google';\n",
		);
		const { status, output } = runCheck(dir);
		// The hosted session migration removed this route family and its
		// constants ownership; the gate only owns current API paths.
		expect(status).toBe(0);
		expect(output).toContain('no hardcoded API path literals');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
