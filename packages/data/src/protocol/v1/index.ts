/**
 * Scalar Sync V1 protocol kernel (ADR-0163, ADR-0164, ADR-0160).
 *
 * This is a deliberately private barrel. It is NOT listed in the package
 * `exports` map, so no production consumer can import it: the kernel stands
 * beside the current combined-exchange protocol without replacing or composing
 * with it. Tests import from here; the local replica (Wave 2b) and the server
 * authority (Wave 2c) will consume the kernel once those waves land.
 *
 * The kernel is a complete executable contract:
 * - structured row and value addresses;
 * - the four fact shapes and four intent shapes;
 * - the two wire operations, context-aware settlement admission, and the
 *   bounded parked-result shape;
 * - a mandatory limits validator that derives (never trusts) response capacity;
 * - a defensive RFC 8785 canonical encoder and SHA-256 request hash;
 * - the pure authority fold; and
 * - a pure, storage-free reference authority over admitted, validated inputs.
 */

export {
	type Address,
	AddressSchema,
	addressesEqual,
	addressKey,
	isAdmissibleAddress,
	parseAddress,
	type RowAddress,
	RowAddressSchema,
	type ValueAddress,
	ValueAddressSchema,
} from './addresses.js';
export {
	type AuthorityState,
	createAuthority,
	type ReplicaLedger,
	readFacts,
	submit,
} from './authority.js';
export {
	canonicalize,
	deepFreeze,
	isCanonicalJson,
	isDenseDataArray,
	isPlainDataObject,
	isWellFormedString,
	sha256Hex,
	utf8ByteLength,
} from './canonical.js';
export { AuthorityError, ScalarProtocolError } from './errors.js';
export {
	encodedFactBytes,
	type Fact,
	FactSchema,
	isAdmissibleFact,
	parseFact,
	SequenceSchema,
} from './facts.js';
export { type FoldOutcome, foldIntent } from './fold.js';
export {
	type Intent,
	IntentSchema,
	isAdmissibleIntent,
	parseIntent,
} from './intents.js';
export {
	isAdmissibleFieldKey,
	isJsonObject,
	isJsonValue,
	type JsonLimits,
	type JsonObject,
	JsonObjectSchema,
	type JsonValue,
	JsonValueSchema,
} from './json.js';
export {
	minimumFactsResponseBytes,
	minimumSubmissionResponseBytes,
	type ScalarSyncLimits,
	type ValidatedLimits,
	validateLimits,
} from './limits.js';
export {
	type AdmittedFactsRequest,
	type AdmittedSubmissionRequest,
	admitFactsPage,
	admitSettlement,
	type FactsRequest,
	FactsRequestSchema,
	type FactsResponse,
	FactsResponseSchema,
	type ParkedIntent,
	ParkedIntentSchema,
	parseFactsRequest,
	parseFactsResponse,
	parseSubmissionRequest,
	parseSubmissionResponse,
	type SubmissionRequest,
	SubmissionRequestSchema,
	type SubmissionResponse,
	SubmissionResponseSchema,
} from './operations.js';
