/**
 * CLI entry-point tests.
 *
 * The binary surfaces explicit cloud and portable-data workflows. These tests
 * assert registration via `--help` output so they stay decoupled from command
 * semantics.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { createCLI } from './cli.js';

async function captureHelp(argv: string[] = ['--help']): Promise<string> {
	const chunks: string[] = [];
	const logSpy = spyOn(console, 'log').mockImplementation(
		(...args: unknown[]) => {
			chunks.push(args.map((a) => String(a)).join(' '));
		},
	);
	const errSpy = spyOn(console, 'error').mockImplementation(
		(...args: unknown[]) => {
			chunks.push(args.map((a) => String(a)).join(' '));
		},
	);
	try {
		await createCLI()
			.run(argv)
			.catch(() => {});
		return chunks.join('\n');
	} finally {
		logSpy.mockRestore();
		errSpy.mockRestore();
	}
}

describe('createCLI', () => {
	test('rejects with usage when no arguments provided', async () => {
		const cli = createCLI();
		const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

		// exitProcess(false) makes yargs throw instead of calling process.exit
		await expect(cli.run([])).rejects.toThrow(
			'Not enough non-option arguments',
		);

		const errorOutput = errorSpy.mock.calls.flat().join(' ');
		expect(errorOutput).toContain('epicenter');
		errorSpy.mockRestore();
	});

	test('help output registers supported top-level commands', async () => {
		const help = await captureHelp();
		expect(help).toMatch(/\bauth\b/);
		expect(help).toMatch(/\bblobs\b/);
		expect(help).toMatch(/\btables\b/);
		expect(help).toMatch(/\bmatter\b/);
		for (const removed of [
			'up',
			'down',
			'status',
			'logs',
			'init',
			'daemon',
			'ps',
			'peers',
			'run',
		]) {
			expect(help).not.toMatch(new RegExp(`\\bepicenter ${removed}\\b`));
		}
	});

	test('generic process lifecycle commands are gone', async () => {
		const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

		try {
			for (const command of [
				'up',
				'down',
				'status',
				'logs',
				'init',
				'daemon',
				'ps',
			]) {
				await expect(createCLI().run([command])).rejects.toThrow(
					`Unknown argument: ${command}`,
				);
			}
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('auth status rejects extra positionals', async () => {
		const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

		try {
			await expect(
				createCLI().run(['auth', 'status', 'not-a-url']),
			).rejects.toThrow('Unknown argument: not-a-url');
			expect(errorSpy.mock.calls.flat().join(' ')).toContain(
				'Unknown argument: not-a-url',
			);
		} finally {
			errorSpy.mockRestore();
		}
	});
});
