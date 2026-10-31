/** Portable declarations: schema data and readers, with no storage lifetime. */

export { readSavedViews } from '../declaration.js';
export {
	type Declaration,
	type PortableTableSchema,
	type SavedView,
} from '../declaration-schema.js';
export { changeSavedView, type SavedViewChange } from '../declaration-write.js';
