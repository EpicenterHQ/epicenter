/** Inert data-definition vocabulary. Runtime store entrypoints live beside it. */

export {
	CalendarDateString,
	DateTimeString,
	type Field,
	type FieldOf,
	InstantString,
	jsonValue,
	type Kind,
	REFERENCE_KEYWORD,
	recognize,
	referenceTargetOf,
} from '../field/index.js';
export * from './addresses.js';
export { plainText } from './body.js';
export {
	type Conformance,
	type ConformanceIssue,
	compileData,
	DataDefinitionParseError,
	type ParsedDataDefinition,
	type ParsedTable,
} from './compile.js';
export {
	type BodyCodec,
	type CreateRowOf,
	type DataDefinition,
	type FieldMap,
	field,
	type KvOf,
	type RowOf,
	type TableDeclaration,
} from './declaration.js';
export { defineTable } from './define.js';
export * from './json.js';
