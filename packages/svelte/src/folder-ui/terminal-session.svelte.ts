/**
 * One terminal session over a folder: its output, command history, typed
 * command, and working directory. It lives as long as the opened folder, so
 * hiding the terminal or switching layouts keeps everything on screen.
 */
import type { FolderTerminal, TerminalResult } from '@epicenter/folder';

/** One command the session ran, and its result once it finished. */
export type TerminalRun = {
	readonly id: number;
	readonly cwd: string;
	readonly command: string;
	result?: TerminalResult;
};

export type TerminalSession = ReturnType<typeof createTerminalSession>;

export function createTerminalSession({
	terminal,
	afterRun,
	locked = () => false,
}: {
	/** The shell, such as `folder.terminal()` or an app's wrapper around it. */
	terminal: Pick<FolderTerminal, 'cwd' | 'exec'>;
	/** Shell writes are saved files; the app shows them and rechecks status. */
	afterRun: () => Promise<void>;
	/**
	 * While true, typing, recall, and Enter change nothing: the command,
	 * history, and output stay exactly as they are, as while the app closes.
	 */
	locked?: () => boolean;
}) {
	let runs = $state<TerminalRun[]>([]);
	let command = $state('');
	let running = $state(false);
	let cwd = $state(terminal.cwd);
	let history: string[] = [];
	let cursor = -1;
	let nextId = 0;

	return {
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
			if (locked()) return;
			command = value;
		},
		/** Typing, recall, and Enter are refused. */
		get locked() {
			return locked();
		},
		/** Run the typed command. `clear` empties the output without running. */
		async run() {
			const line = command.trim();
			if (line === '' || running || locked()) return;
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
			await afterRun();
		},
		/** Step through earlier commands. Returns false when there is none to recall. */
		recall(direction: 'previous' | 'next'): boolean {
			if (history.length === 0 || locked()) return false;
			if (direction === 'previous')
				cursor = cursor < 0 ? history.length - 1 : Math.max(0, cursor - 1);
			else
				cursor = cursor < 0 || cursor + 1 >= history.length ? -1 : cursor + 1;
			command = cursor < 0 ? '' : history[cursor]!;
			return true;
		},
	};
}
