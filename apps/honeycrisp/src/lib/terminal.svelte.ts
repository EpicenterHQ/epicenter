/**
 * One terminal session over the notes folder: its output, command history,
 * typed command, and working directory. It lives as long as the opened
 * folder, so hiding the terminal keeps everything on screen.
 */
import type { NotesTerminal, TerminalRun } from './platform/types.js';

export type TerminalEntry = {
	readonly id: number;
	readonly cwd: string;
	readonly command: string;
	result?: TerminalRun;
};

export type TerminalSession = ReturnType<typeof createTerminalSession>;

export function createTerminalSession(
	/** Runs each command; the notes state reads the folder again after one. */
	terminal: NotesTerminal,
	/** Whether a command may start. False once the notes are closing. */
	admits: () => boolean = () => true,
) {
	let runs = $state<TerminalEntry[]>([]);
	let command = $state('');
	let running = $state(false);
	let cwd = $state(terminal.cwd);
	let history: string[] = [];
	let cursor = -1;
	let nextId = 0;

	return {
		description: terminal.description,
		get runs() {
			return runs;
		},
		get running() {
			return running;
		},
		get cwd() {
			return cwd;
		},
		/** The command being typed; kept while the terminal is hidden. */
		get command() {
			return command;
		},
		set command(value: string) {
			command = value;
		},
		/** Whether a command may start now. */
		get admitting() {
			return admits();
		},
		/**
		 * Run the typed command. `clear` empties the output without running.
		 * Nothing starts, and the typed command stays, while commands are held.
		 */
		async run() {
			const line = command.trim();
			if (line === '' || running || !admits()) return;
			command = '';
			cursor = -1;
			if (line === 'clear') {
				runs = [];
				return;
			}
			history = [...history.filter((item) => item !== line), line];
			runs.push({ id: nextId++, cwd, command: line });
			const run = runs[runs.length - 1]!;
			running = true;
			try {
				run.result = await terminal.exec(line);
			} catch (error) {
				run.result = {
					stdout: '',
					stderr: `${error instanceof Error ? error.message : String(error)}\n`,
					exitCode: 1,
				};
			} finally {
				running = false;
				cwd = terminal.cwd;
			}
		},
		/** Step through earlier commands. Returns false when there is none to recall. */
		recall(direction: 'previous' | 'next'): boolean {
			if (history.length === 0) return false;
			if (direction === 'previous')
				cursor = cursor < 0 ? history.length - 1 : Math.max(0, cursor - 1);
			else
				cursor = cursor < 0 || cursor + 1 >= history.length ? -1 : cursor + 1;
			command = cursor < 0 ? '' : history[cursor]!;
			return true;
		},
	};
}
