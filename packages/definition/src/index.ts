/**
 * `@epicenter/definition`: inert data-definition vocabulary, its preparation,
 * and the reads over a prepared schema.
 *
 * A storage imports this to read a declaration; it acquires nothing and knows
 * no storage. `@epicenter/folder` is the one storage.
 */

export {
	type ConformanceIssue,
	type CreateRowOf,
	type DataSchema,
	type DeclaredMark,
	type DeclaredTable,
	type FieldMap,
	field,
	KV_ROOT,
	type KvOf,
	RESERVED_TABLE_NAMES,
	type RowOf,
	type TableDeclaration,
} from './declaration.js';
export {
	type DefineTable,
	defineTable,
	type ValidateFields,
} from './define.js';
export {
	type Annotated,
	CalendarDateString,
	DateTimeString,
	FIELD_KEYWORD,
	type FieldEditor,
	type FieldHint,
	fieldEditorOf,
	InstantString,
	jsonValue,
	type Kind,
} from './field/index.js';
export * from './json.js';
export {
	type CheckMode,
	type Conformance,
	check,
	DataDefinitionParseError,
	isOptional,
	prepareSchema,
} from './prepare.js';
export {
	requiredOutsideShape,
	type ShapeProblem,
	schemaContainment,
	shapeProblems,
} from './shape.js';
