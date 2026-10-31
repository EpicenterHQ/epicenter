/**
 * Where this page keeps todos, and whether it uploads them.
 *
 * - In a browser, this origin's private files (OPFS, `@epicenter/folder/browser`).
 *   A todo made there signed out or offline uploads once someone signs in.
 * - In Todos' desktop window, the folder its shell bound to the window
 *   (`@epicenter/folder/tauri`). The page never signs in: Epicenter syncs
 *   that folder (`epicenter sync`), so nothing here uploads.
 *
 * Both are the same contract's client at the same paths.
 */
import { openDevice as openBrowserDevice } from '@epicenter/folder/browser';
import { openDevice as openFolderDevice } from '@epicenter/folder/tauri';
import { isTauri } from '@tauri-apps/api/core';
import { todos } from './contract.js';

/** Whether this page is Todos' desktop window, whose folder Epicenter syncs. */
export const isDesktop = isTauri();

/** This page's device client: the desktop window's folder, or this browser's files. */
export const openTodosDevice = () =>
	isDesktop ? openFolderDevice(todos) : openBrowserDevice(todos);
