/**
 * Dependency Isolation Tests
 *
 * The compiler resolves the complete Folder and definition programs, including
 * tests and type imports. Neither may pull in App, authentication, or Yjs.
 * Runtime adapter isolation is covered by the emitted Vite bundle tests.
 */
import { describe, expect, test } from 'bun:test';
import { join, relative, resolve } from 'node:path';

const FOLDER = resolve(import.meta.dir, '../..');
const PACKAGES = resolve(FOLDER, '..');
const DEFINITION = join(PACKAGES, 'definition');

describe('what the TypeScript program loads', () => {
	async function program(directory: string) {
		const child = Bun.spawn(
			[
				join(FOLDER, 'node_modules/typescript/bin/tsc'),
				'--noEmit',
				'--listFilesOnly',
				'-p',
				directory,
			],
			{ stdout: 'pipe', stderr: 'pipe' },
		);
		const [out, code] = await Promise.all([
			new Response(child.stdout).text(),
			child.exited,
		]);
		expect(code).toBe(0);
		return out.split('\n').filter(Boolean);
	}

	test.each([
		['folder', FOLDER],
		['definition', DEFINITION],
	])(
		'the %s program, tests included, loads only its declared workspace leaves and no App or Yjs',
		async (name, directory) => {
			const files = await program(directory);
			expect(files.some((file) => file.startsWith(`${directory}/src/`))).toBe(
				true,
			);
			const workspace = files
				.filter((file) => file.startsWith(`${PACKAGES}/`))
				.map((file) => relative(PACKAGES, file).split('/')[0]);
			expect([...new Set(workspace)].sort()).toEqual(
				name === 'folder' ? ['definition', 'folder'] : ['definition'],
			);
			const forbidden = files.filter(
				(file) =>
					/node_modules\/(\.bun\/)?(@y[+/]|yjs|lib0|y-protocols|openai|better-auth)/.test(
						file,
					) || /\/packages\/(app|auth|recorder|sync|client)\//.test(file),
			);
			expect(forbidden).toEqual([]);
		},
		120_000,
	);
});
