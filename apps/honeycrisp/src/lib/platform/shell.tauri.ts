/**
 * The page's side of Honeycrisp's own shell commands: the terminal, per-file
 * history, and reveal. The folder itself comes from
 * `@epicenter/folder/tauri`; nothing here reads or writes a note.
 */
import { invoke } from '@tauri-apps/api/core';
import type { FileRevision, NotesHost } from './types.js';

type ShellInfo = {
	/** The absolute notes directory. */
	readonly root: string;
	/** Where the next terminal command starts, absolute. */
	readonly cwd: string;
};

type TerminalReply = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly cwd: string;
};

/**
 * The parts of a `NotesHost` the shell's own commands provide. The shell
 * holds the root and the terminal's working directory; this sends neither.
 */
export async function openShellServices(): Promise<
	Pick<NotesHost, 'terminal' | 'location' | 'reveal' | 'history'>
> {
	const info = await invoke<ShellInfo>('shell_info');
	let cwd = info.cwd;
	const shown = (path: string) =>
		path === info.root
			? '/'
			: path.startsWith(`${info.root}/`)
				? path.slice(info.root.length)
				: path;
	return {
		terminal: {
			get cwd() {
				return shown(cwd);
			},
			description: `/bin/sh in ${info.root} · the same files, real git`,
			async exec(command) {
				const reply = await invoke<TerminalReply>('terminal_run', { command });
				cwd = reply.cwd;
				return reply;
			},
		},
		location: info.root,
		// A refused command rejects with the shell's own words, as text.
		reveal: () =>
			invoke<void>('reveal_folder').then(
				() => undefined,
				(cause) => String(cause),
			),
		history: {
			log: (path, depth) => invoke<FileRevision[]>('file_log', { path, depth }),
			show: (oid, path) => invoke<string>('file_show', { oid, path }),
		},
	};
}
