import {
	createBrowserSecrets,
	createBrowserSqliteOwner,
} from '@epicenter/device/browser';

export const resources = {
	sqlite: createBrowserSqliteOwner(),
	secrets: createBrowserSecrets,
};
