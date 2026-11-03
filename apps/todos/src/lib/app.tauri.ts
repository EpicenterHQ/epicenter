/**
 * `#platform/app` in Todos' desktop window: its two roots (decision 94), the
 * AppData root and then the data folder it names, opened before any page
 * module runs. Either one that cannot open throws `StartupFailed`, and the
 * recovery screen offers what fixes it; a fix reloads the page. Choosing
 * another data folder reloads it too. The window never signs in: Epicenter
 * syncs the folder once the person asks.
 */
import {
	type FolderSettings,
	type OpenDeviceError,
	openAppData,
	openDataFolder,
} from '@epicenter/folder/tauri';
import { fromClient } from '@epicenter/svelte/client';
import { todos as contract } from './contract.js';
import { todosSettings } from './folder.tauri.js';
import { StartupFailed } from './startup.js';
import type { TodoList } from './todos.js';

/** Which root did not open, and why: `appData` is there when only the data folder failed. */
export type StartupFailure = {
	error: OpenDeviceError;
	appData?: FolderSettings;
};

const openedAppData = await openAppData(todosSettings);
if (openedAppData.error !== null)
	throw new StartupFailed<StartupFailure>(openedAppData.error.message, {
		error: openedAppData.error,
	});

/** The AppData root: this computer's settings, its `settings.md` naming the data folder. */
export const appData: FolderSettings = openedAppData.data;

const openedFolder = await openDataFolder(contract, { appData });
if (openedFolder.error !== null)
	throw new StartupFailed<StartupFailure>(openedFolder.error.message, {
		error: openedFolder.error,
		appData,
	});

/** The data folder's client. */
export const folder = openedFolder.data;

export const todos: TodoList = fromClient(folder).todos;

// A new world is a new page, in development too.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
