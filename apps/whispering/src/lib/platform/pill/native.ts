/**
 * The pill in the desktop app: Tauri events between the two windows, and
 * `pill_show`, which places and shows or hides the pill's window
 * (`pill.rs`). The window labels match `main.rs`.
 */
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Pill, PillAction, PillState } from './pill';

const MAIN = 'main';
const PILL = 'pill';
const STATE = 'pill-state';
const ACTION = 'pill-action';

/** Listen for `event` until the returned function is called, even if that is before listening starts. */
function hear<T>(event: string, handle: (payload: T) => void): () => void {
	const listening = listen<T>(event, ({ payload }) => handle(payload));
	return () => void listening.then((stop) => stop());
}

export const nativePill: Pill = {
	publish(state) {
		void emitTo<PillState>(PILL, STATE, state);
	},
	onAction(handle) {
		return hear<PillAction>(ACTION, async (action) => {
			if (action.kind === 'show') {
				const window = getCurrentWindow();
				await window.unminimize();
				await window.show();
				await window.setFocus();
			}
			handle(action);
		});
	},
	onState: (handle) => hear<PillState>(STATE, handle),
	send(action) {
		void emitTo<PillAction>(MAIN, ACTION, action);
	},
	setShown(shown) {
		void invoke('pill_show', { shown });
	},
};
