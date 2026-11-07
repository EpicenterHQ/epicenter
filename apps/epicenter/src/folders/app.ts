/**
 * The Folders window's capabilities, opened once when the page loads
 * (ADR-0766): the Epicenter folder through the folder plugin, every folder
 * in it a store of its own (`epicenterRoot`), this computer's settings,
 * where the shell writes who is signed in, and the app's own sign-in as
 * `so.epicenter`, whose every request the shell sends with the Git
 * audience's token, as the folder routes expect. The page composes
 * `@epicenter/folder/platform` over them and runs no CLI (ADR-0817).
 */
import { createTauriAuth } from '@epicenter/account/tauri';
import { epicenterRoot } from '@epicenter/folder/tauri';
import { settings } from '@epicenter/local';
import { reactive } from '@epicenter/svelte/reactive';

export const root = epicenterRoot();
export const auth = reactive(createTauriAuth({ audience: 'folders' }));
export const localSettings = reactive(settings);
