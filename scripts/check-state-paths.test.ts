/**
 * State Path Gate Tests
 *
 * Drives `check-state-paths.ts` against throwaway Git repositories, since
 * the gate scans the tracked files of `git rev-parse --show-toplevel`.
 *
 * Key behaviors:
 * - A `.epicenter` literal in production code fails, with file and line
 * - The owning modules, tests, test support, smoke runs, Rust test modules,
 *   comments, docs, and dotted names that contain the word pass
 */

import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(
	new URL('./check-state-paths.ts', import.meta.url),
);

/** A repository tracking `files`. */
function repoWith(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'state-paths-'));
	execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
	for (const [rel, body] of Object.entries(files)) {
		const target = path.join(dir, rel);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, body);
	}
	execFileSync('git', ['add', '--', '.'], { cwd: dir });
	return dir;
}

function runCheck(dir: string): { status: number | null; output: string } {
	const result = spawnSync('bun', ['run', scriptPath], {
		cwd: dir,
		encoding: 'utf8',
	});
	return { status: result.status, output: result.stdout + result.stderr };
}

test('a .epicenter literal in production code fails with its file and line', () => {
	const dir = repoWith({
		'packages/cli/src/sync.ts': "const a = 1;\nconst skip = '.epicenter/';\n",
		'packages/core/src/save.rs':
			'fn saves() -> &\'static str {\n    ".epicenter/saves"\n}\n',
	});
	try {
		const { status, output } = runCheck(dir);
		expect(status).toBe(1);
		expect(output).toContain('packages/cli/src/sync.ts:2:');
		expect(output).toContain('packages/core/src/save.rs:2:');
		expect(output).toContain('::error::.epicenter spelled outside its owners');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('owners, tests, comments, docs, and dotted names pass', () => {
	const dir = repoWith({
		'packages/folder/src/state.ts':
			"export const STATE_DIRECTORY = '.epicenter';\n",
		'packages/tauri-plugin-epicenter-folder/core/src/state.rs':
			'pub const DIRECTORY: &str = ".epicenter";\n',
		'packages/folder/src/store.test.ts': "join(root, '.epicenter');\n",
		'apps/capture/src/lib/device.test-support.ts': "'.epicenter/'\n",
		'packages/recorder/src/tests.rs': 'root.join(".epicenter/recordings");\n',
		'packages/folder/smoke/device.ts': "getDirectoryHandle('.epicenter');\n",
		'packages/recorder/src/wav.rs':
			'//! Pending in `.epicenter/recordings`.\nfn main() {}\n\n#[cfg(test)]\nmod tests {\n    fn t() {\n        let _ = ".epicenter/recordings";\n    }\n}\n',
		'packages/folder/src/watch.ts':
			"/**\n * Unfinished writes live in `.epicenter`.\n */\n// .epicenter is hidden\nconst id = 'so.epicenter.todos';\nconst api = 'https://api.epicenter.so';\nconst demo = '.epicenter-todos-demo';\n",
		'packages/folder/README.md': 'Saves stage in `.epicenter/saves`.\n',
	});
	try {
		const { status, output } = runCheck(dir);
		expect(output).toContain('.epicenter is spelled only by its owners');
		expect(status).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
