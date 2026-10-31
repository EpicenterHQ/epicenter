/**
 * Vocab's desktop window's two roots as its components read them (decisions
 * 88 to 94): the AppData root's settings (`getAppData`) and the data
 * folder's client (`getDevice`), each wrapped once for Svelte where
 * `DesktopRoot` sets them, and where Vocab publishes its contract. Only the
 * desktop leaves import this.
 */
import { APPS } from '@epicenter/constants/apps';
import type { AppConfig } from '@epicenter/folder/tauri';
import type { ReactiveClient } from '@epicenter/svelte/client';
import { createContext } from 'svelte';
import type { Vocab } from './contract.js';

/** Where Vocab's web app publishes its contract (`static/contract.json`). */
export const CONTRACT_URL = `${APPS.VOCAB.url}/contract.json`;

export const [getAppData, setAppData] =
	createContext<ReactiveClient<AppConfig>>();
export const [getDevice, setDevice] = createContext<ReactiveClient<Vocab>>();
