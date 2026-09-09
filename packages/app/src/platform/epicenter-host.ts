import {
	createDesktopSecrets,
	createDesktopSqliteOwner,
} from '@epicenter/device/desktop';
import type { resources as browserResources } from './browser.js';

export const resources: typeof browserResources = {
	sqlite: createDesktopSqliteOwner(),
	secrets: createDesktopSecrets,
};
