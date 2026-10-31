/**
 * Open in Epicenter, offered by Todos' desktop app.
 *
 * The Todos shell names the directory its window was granted and asks the
 * operating system to open `epicenter://init?path=…&contract=…`
 * (`open_in_epicenter` in `src-tauri/src/lib.rs`): a request that Epicenter
 * sync that folder, read under Todos' published contract. The page names no
 * path. The browser build has no shell, so it does not offer the action.
 *
 * The shell's answer says only that the system took the request. Epicenter
 * asks the person before it sets the folder up, so the page never says the
 * folder is syncing.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';

/** What the page needs of the native shell, or `undefined` without one. */
export type TodosShell =
	| {
			openInEpicenter(): Promise<void>;
	  }
	| undefined;

export type HandoffStatus =
	| { tone: 'requested'; message: string }
	| { tone: 'failed'; message: string };

/** This page's shell: Todos' Tauri one, or none in a browser. */
export function currentShell(): TodosShell {
	if (!isTauri()) return undefined;
	return { openInEpicenter: () => invoke<void>('open_in_epicenter') };
}

/** Ask `shell` to hand its folder to Epicenter, and say what is known. */
export async function openInEpicenter(
	shell: NonNullable<TodosShell>,
): Promise<HandoffStatus> {
	try {
		await shell.openInEpicenter();
		return {
			tone: 'requested',
			message:
				'Asked your computer to open Epicenter. If it is installed, choose Set up in its Folders window.',
		};
	} catch (cause) {
		return {
			tone: 'failed',
			message: `Could not ask your computer to open Epicenter. ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		};
	}
}
