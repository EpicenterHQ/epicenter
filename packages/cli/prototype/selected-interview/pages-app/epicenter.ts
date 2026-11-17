import { defineApp } from '@epicenter/app';
import { collectionsOf } from './directory.prototype';
import { pageActions } from './page-actions';
import { pages } from './pages';

export default defineApp({
	description: 'Pages and their video cuts',
	collections: collectionsOf({ pages }),
	actions: { pages: pageActions },
});
