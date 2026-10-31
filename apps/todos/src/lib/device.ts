/**
 * The local variant's store: where it keeps todos, opened once for the page
 * and only by the local variant's page (the online variant never imports it).
 *
 * - In a browser, this origin's private files (OPFS, `@epicenter/folder/browser`),
 *   for good: they never sync and never upload (ADR-0700).
 * - In Todos' desktop window, the folder its shell bound to the window
 *   (`@epicenter/folder/tauri`). The page never signs in: Epicenter syncs
 *   that folder (`epicenter sync`).
 *
 * Both are the same contract's client at the same paths.
 */
import {
	closeDevice,
	openDevice as openBrowserDevice,
} from '@epicenter/folder/browser';
import { openDevice as openFolderDevice } from '@epicenter/folder/tauri';
import { isTauri } from '@tauri-apps/api/core';
import { todos } from './contract.js';

/** This page's device client: the desktop window's folder, or this browser's files. */
export const device = isTauri()
	? openFolderDevice(todos)
	: openBrowserDevice(todos);

if (import.meta.hot) import.meta.hot.dispose(() => closeDevice(device));
