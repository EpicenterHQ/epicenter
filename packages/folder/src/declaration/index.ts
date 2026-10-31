/** Portable declarations: schema data and readers, with no storage lifetime. */

export {
	parseDeclaration,
	parseDeclarationObject,
	readDeclaredTables,
	readSavedViews,
	readTableSchemas,
} from '../declaration.js';
export {
	type Declaration,
	DeclarationSchema,
	type PortableTableSchema,
	type SavedView,
	type SavedViewFilter,
	SavedViewSchema,
	type SavedViewSort,
	validateTableSchema,
} from '../declaration-schema.js';
export { changeSavedView, type SavedViewChange } from '../declaration-write.js';
