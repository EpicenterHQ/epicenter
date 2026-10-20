/** Portable declarations: schema data and readers, with no storage lifetime. */
export {
	DeclarationSchema,
	type Declaration,
	type PortableTableSchema,
	validateTableSchema,
} from '../declaration-schema.js';
export {
	parseDeclaration,
	parseDeclarationObject,
	readDeclaredTables,
	readTableSchemas,
} from '../declaration.js';
export { exportTables } from '../schema-export.js';
