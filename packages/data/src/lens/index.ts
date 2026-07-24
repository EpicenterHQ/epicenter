export {
	type CompiledLens,
	type CompiledTable,
	type CompiledValue,
	compileLens,
	type NormalizedUpdate,
} from './compile.js';
export {
	type ConstrainedUpdate,
	type CreateInputFor,
	deepFreeze,
	defineLens,
	defineTable,
	defineValues,
	type LensDefinition,
	type RowFor,
	type TableDefinition,
	type ValuesDefinition,
	type ValueTypeFor,
} from './definitions.js';
export {
	type ConformanceIssue,
	LensParseError,
	type LensReadError,
	type NonconformingRowError,
	type NonconformingValueError,
} from './errors.js';
export {
	isLensLocalKey,
	isLensNamespace,
	isLensValuesKey,
} from './grammar.js';
export { parseLens } from './parse-lens.js';
