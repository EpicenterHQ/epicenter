/**
 * `@epicenter/definition`: inert definition vocabulary, its preparation, and
 * the reads over a prepared definition.
 *
 * A storage imports this to read a definition; it acquires nothing and knows
 * no storage. `@epicenter/folder` is the one storage.
 */

export {
	type ConformanceIssue,
	type CreateRowOf,
	type DeclaredMark,
	type DeclaredTable,
	type Definition,
	type FieldMap,
	field,
	SETTINGS_TABLE,
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
	DefinitionError,
	isOptional,
	prepareDefinition,
} from './prepare.js';
export {
	containment,
	type Mismatch,
	mismatches,
	requiredOutside,
} from './shape.js';
