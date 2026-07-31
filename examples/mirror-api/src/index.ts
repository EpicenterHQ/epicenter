export type {
	ColumnType,
	DerivedRow,
	DerivedTable,
	Emit,
	Extractor,
	MirrorDeclaration,
	MirrorSpec,
	ObjectOf,
	PathRef,
	Retention,
	SourceKeys,
	SourceTable,
	TableMap,
	VersionOrder,
} from './declare.ts';
export {
	defineMirror,
	derived,
	isPathRef,
	MirrorDeclarationError,
	path,
	table,
} from './declare.ts';

export {
	CanonicalizationError,
	canonicalize,
	computeFingerprint,
	rebuildRelevant,
} from './fingerprint.ts';
export type {
	IngestBatches,
	IngestOptions,
	IngestReport,
	MirrorReaderHandle,
	MirrorWriter,
	OpenedMirrorReader,
	OpenWriterOptions,
} from './open.ts';

export {
	MirrorProjectionError,
	MirrorSupersededError,
	openMirrorReader,
	openMirrorWriter,
} from './open.ts';
export { describeMirror } from './schema.ts';
