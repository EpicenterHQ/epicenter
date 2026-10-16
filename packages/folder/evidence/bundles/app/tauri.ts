/** An application that names the desktop entry itself. */
import { defineFolder, openFolder } from '@epicenter/folder/tauri';

const definition = defineFolder({
	tables: {},
});

export const start = () =>
	openFolder({ id: 'so.epicenter.bundlefixture', definition });
