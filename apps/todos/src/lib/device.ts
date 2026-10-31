/**
 * The desktop variant's store: the folder Todos' shell bound to its window
 * (`@epicenter/folder/tauri`), opened once for the page. Only the desktop
 * root (`Desktop.svelte`, loaded only in the window) imports it, so a
 * browser never opens it. The page never signs in: Epicenter syncs that
 * folder (`epicenter sync`).
 */
import { openDevice } from '@epicenter/folder/tauri';
import { todos } from './contract.js';

/** The desktop window's folder, as the contract's client. */
export const device = openDevice(todos);
