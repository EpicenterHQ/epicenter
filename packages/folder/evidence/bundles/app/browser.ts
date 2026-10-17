/** An application that names the browser entry itself. */
import { defineFolder, openFolder } from '@epicenter/folder/browser';

const definition = defineFolder({
	tables: {},
});

export const start = () =>
	openFolder({ app: 'so.epicenter.bundlefixture', definition });
