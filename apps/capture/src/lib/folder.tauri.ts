/**
 * Capture's desktop window's two roots as its components read them
 * (decisions 88 to 94): the AppData root's settings (`getAppData`, through
 * Capture's own settings contract) and the data folder's client
 * (`getDevice`), each wrapped once for Svelte where `DesktopRoot` sets them,
 * and where Capture publishes its contract. Only the desktop leaves import
 * this.
 */

import type { Capture } from '@epicenter/capture';
import { APPS } from '@epicenter/constants/apps';
import { defineContract } from '@epicenter/definition/contract';
import type { ReactiveClient } from '@epicenter/svelte/client';
import { createContext } from 'svelte';

/** Where Capture's web app publishes its contract (`static/contract.json`). */
export const CONTRACT_URL = `${APPS.CAPTURE.url}/contract.json`;

/**
 * Capture's settings notes (decisions 86 to 89). Capture has no settings of
 * its own yet, so its one note is the AppData root's `settings.md`, whose
 * only key is `folder`: the data folder this computer opens, absent for the
 * default.
 */
export const captureSettings = defineContract({
	name: 'capture-settings',
	description:
		"Capture's settings notes: on this computer, `folder` is the data folder it opens.",
	collections: {
		settings: { path: 'settings.md', fields: { folder: { type: 'string' } } },
	},
});

export type CaptureSettings = typeof captureSettings;

export const [getAppData, setAppData] =
	createContext<ReactiveClient<CaptureSettings>>();
export const [getDevice, setDevice] = createContext<ReactiveClient<Capture>>();
