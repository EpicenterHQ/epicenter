/**
 * What Whispering's desktop window asks its shell beyond files, requests
 * and the microphone: the folder it keeps its files in, and "Choose
 * folder…" (`epicenter-standalone`'s `folder_path` and `choose_folder`), and
 * the global shortcut's presses (`src-tauri/src/shortcut.rs`). The first run's
 * question, where to keep the files, is the shell's own dialog, asked before
 * the window opens. Only the desktop build reaches this module.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Err, Ok, type Result } from 'wellcrafted/result';

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/** The folder this window keeps Whispering's files in, as an absolute path. */
export const folderPath = () => invoke<string>('folder_path');

/**
 * "Choose folder…": the shell asks for a folder and moves Whispering there
 * in a new window, closing this one. Ok with `false` when the person
 * cancelled. Wait for saves before asking.
 */
export async function chooseFolder(): Promise<Result<boolean, string>> {
	try {
		return Ok(await invoke<boolean>('choose_folder'));
	} catch (cause) {
		return Err(describe(cause));
	}
}

/** The global shortcut, as the shell registers it. */
export const SHORTCUT_LABEL = navigator.userAgent.includes('Mac')
	? '⌘⇧;'
	: 'Ctrl+Shift+;';

/** Hear each press of the global shortcut. Answers the unsubscribe. */
export function onShortcut(listener: () => void): () => void {
	let stop: (() => void) | undefined;
	let stopped = false;
	void listen('whispering://toggle-recording', listener).then((unlisten) => {
		if (stopped) unlisten();
		else stop = unlisten;
	});
	return () => {
		stopped = true;
		stop?.();
	};
}
