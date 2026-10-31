/**
 * Open in Epicenter, offered by standalone Todos alone (ADR-0646).
 *
 * The Todos shell names the directory its window was granted and asks the
 * operating system to open `epicenter://open?path=…` (`open_in_epicenter` in
 * `src-tauri/src/lib.rs`); the page names no path. The browser build has no
 * shell, and Todos inside Epicenter runs under Epicenter's identifier, so
 * neither offers the action.
 *
 * The shell's answer says only that the system took the request. Epicenter
 * asks the person before it reads the folder, so the page never says the
 * folder opened there.
 */
import { getIdentifier } from '@tauri-apps/api/app';
import { invoke, isTauri } from '@tauri-apps/api/core';

/** Standalone Todos's identifiers: the release app and the development one. */
const STANDALONE_TODOS = new Set([
	'so.epicenter.todos',
	'so.epicenter.todos.dev',
]);

/** What the page needs of the native shell, or `undefined` without one. */
export type TodosShell =
	| {
			identifier(): Promise<string>;
			openInEpicenter(): Promise<void>;
	  }
	| undefined;

export type HandoffStatus =
	| { tone: 'requested'; message: string }
	| { tone: 'failed'; message: string };

/** This page's shell: the Tauri one, or none in a browser. */
export function currentShell(): TodosShell {
	if (!isTauri()) return undefined;
	return {
		identifier: getIdentifier,
		openInEpicenter: () => invoke<void>('open_in_epicenter'),
	};
}

/**
 * Whether `shell` is standalone Todos's. A shell that refuses to say, as
 * Epicenter's refuses its bundled apps, is not.
 */
export async function offersOpenInEpicenter(shell: TodosShell) {
	if (shell === undefined) return false;
	try {
		return STANDALONE_TODOS.has(await shell.identifier());
	} catch {
		return false;
	}
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
				'Asked your computer to open Epicenter. If it is installed, choose Open in its Folders window.',
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
