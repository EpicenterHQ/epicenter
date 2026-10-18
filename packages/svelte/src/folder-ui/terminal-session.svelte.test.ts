/**
 * Terminal Session Tests
 *
 * Drives one terminal session over a stand-in shell that records what it was
 * asked to run.
 *
 * Key behaviors:
 * - A command runs once, its result and the directory it ended in are kept,
 *   and the app rechecks the folder after it
 * - `clear` empties the output without running anything
 * - A shell that throws reads as a failed command, not a lost one
 * - Up and Down step through earlier commands, each once, newest last
 * - While locked, typing, recall, and Enter change nothing
 */
import '../svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { TerminalResult } from '@epicenter/folder';

const { createTerminalSession } = await import('./terminal-session.svelte.ts');

function setup(
	options: {
		exec?: (command: string) => Promise<TerminalResult>;
		locked?: () => boolean;
	} = {},
) {
	const ran: string[] = [];
	let afterRuns = 0;
	const shell = {
		cwd: '/',
		exec:
			options.exec ??
			(async (command: string) => {
				ran.push(command);
				if (command.startsWith('cd ')) shell.cwd = command.slice(3);
				return { stdout: `ran ${command}\n`, stderr: '', exitCode: 0 };
			}),
	};
	const session = createTerminalSession({
		terminal: shell,
		afterRun: async () => {
			afterRuns++;
		},
		locked: options.locked,
	});
	return { session, ran, afterRuns: () => afterRuns };
}

test('a command runs once and keeps its result and the directory it ended in', async () => {
	const { session, ran, afterRuns } = setup();
	session.command = '  cd /todos  ';
	await session.run();
	expect(ran).toEqual(['cd /todos']);
	expect(session.command).toBe('');
	expect(session.running).toBe(false);
	expect(session.cwd).toBe('/todos');
	expect(session.runs).toEqual([
		{
			id: 0,
			cwd: '/',
			command: 'cd /todos',
			result: { stdout: 'ran cd /todos\n', stderr: '', exitCode: 0 },
		},
	]);
	expect(afterRuns()).toBe(1);
});

test('clear empties the output without running anything', async () => {
	const { session, ran, afterRuns } = setup();
	session.command = 'ls';
	await session.run();
	session.command = 'clear';
	await session.run();
	expect(session.runs).toEqual([]);
	expect(ran).toEqual(['ls']);
	expect(afterRuns()).toBe(1);
});

test('a shell that throws reads as a failed command', async () => {
	const { session } = setup({
		exec: async () => {
			throw new Error('The folder is closed');
		},
	});
	session.command = 'ls';
	await session.run();
	expect(session.runs[0]?.result).toEqual({
		stdout: '',
		stderr: 'The folder is closed\n',
		exitCode: 1,
	});
	expect(session.running).toBe(false);
});

test('up and down step through earlier commands, each once, newest last', async () => {
	const { session } = setup();
	expect(session.recall('previous')).toBe(false);
	for (const command of ['ls', 'pwd', 'ls']) {
		session.command = command;
		await session.run();
	}
	expect(session.recall('previous')).toBe(true);
	expect(session.command).toBe('ls');
	session.recall('previous');
	expect(session.command).toBe('pwd');
	// The oldest command stays put.
	session.recall('previous');
	expect(session.command).toBe('pwd');
	session.recall('next');
	expect(session.command).toBe('ls');
	// Past the newest command is an empty line.
	session.recall('next');
	expect(session.command).toBe('');
});

test('while locked, typing, recall, and Enter change nothing', async () => {
	let locked = false;
	const { session, ran } = setup({ locked: () => locked });
	session.command = 'ls';
	await session.run();
	session.command = 'pwd';

	locked = true;
	expect(session.locked).toBe(true);
	session.command = 'rm -r todos';
	expect(session.command).toBe('pwd');
	expect(session.recall('previous')).toBe(false);
	await session.run();
	expect(ran).toEqual(['ls']);
	expect(session.command).toBe('pwd');

	locked = false;
	await session.run();
	expect(ran).toEqual(['ls', 'pwd']);
});
