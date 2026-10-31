/**
 * Honeycrisp's desktop window's two roots as its components read them
 * (decisions 88 to 94): the AppData root's settings (`getAppData`, through
 * Honeycrisp's own settings contract) and the data folder's client
 * (`getDevice`), each wrapped once for Svelte where `DesktopRoot` sets them,
 * and where Honeycrisp publishes its contract. Only the desktop leaves import
 * this.
 */
import { APPS } from '@epicenter/constants/apps';
import { defineContract } from '@epicenter/definition/contract';
import type { ReactiveClient } from '@epicenter/svelte/client';
import { createContext } from 'svelte';
import type { Honeycrisp } from './contract.js';

/** Where Honeycrisp's web app publishes its contract (`static/contract.json`). */
export const CONTRACT_URL = `${APPS.HONEYCRISP.url}/contract.json`;

/**
 * Honeycrisp's settings notes (decisions 86 to 89). Honeycrisp has no settings of
 * its own yet, so its one note is the AppData root's `settings.md`, whose
 * only key is `folder`: the data folder this computer opens, absent for the
 * default.
 */
export const honeycrispSettings = defineContract({
	name: 'honeycrisp-settings',
	description:
		"Honeycrisp's settings notes: on this computer, `folder` is the data folder it opens.",
	collections: {
		settings: { path: 'settings.md', fields: { folder: { type: 'string' } } },
	},
});

export type HoneycrispSettings = typeof honeycrispSettings;

export const [getAppData, setAppData] =
	createContext<ReactiveClient<HoneycrispSettings>>();
export const [getDevice, setDevice] =
	createContext<ReactiveClient<Honeycrisp>>();
