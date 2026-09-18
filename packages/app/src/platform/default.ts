import { isTauri } from '@tauri-apps/api/core';
import type { AppRuntime } from '../open.js';
import { resources as browser } from './browser.js';
import { resources as host } from './epicenter-host.js';

/** The Epicenter host is the supported Tauri shell; explicit runtimes bypass detection. */
export function defaultRuntime(): AppRuntime {
	return isTauri() ? host : browser;
}
