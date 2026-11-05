/**
 * `@epicenter/definition/front-matter`: read, patch, and merge a note's
 * fields by the `key: <JSON>` grammar, and Git's three-way line merge for
 * its body (ADR-0795, ADR-0796, ADR-0797). Pure functions, no YAML.
 */
export {
	type FieldPatch,
	type FrontMatter,
	isFieldKey,
	type Later,
	type Merged,
	merge3,
	parseFrontMatter,
	patchFrontMatter,
	sameValue,
	stringifyValue,
} from './front-matter.js';
export { type LineMerge, mergeLines } from './line-merge.js';
