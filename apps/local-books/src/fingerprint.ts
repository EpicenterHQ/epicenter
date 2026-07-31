/**
 * Canonical JSON serialization and the domain-separated digest the mirror's
 * rebuild gate is keyed on (`entities.ts` builds the declaration, `db.ts` gates
 * on it).
 *
 * A mirror holds only facts regenerable from its upstream authority, so the
 * shape of the mirror is decided entirely by a declaration the code carries. The
 * declaration's digest is therefore a sound rebuild gate: same declaration, same
 * digest, keep the file; different declaration, rebuild from the upstream. That
 * is only true if the digest depends on the declaration's *meaning* and nothing
 * else, which is what canonical serialization buys. `JSON.stringify` would leak
 * the order properties happened to be authored in, so moving a key would rebuild
 * a mirror for no reason.
 *
 * Two repo-local canonical encoders already exist (`packages/lens/src/canonical`
 * and `packages/data/src/protocol/v1/canonical`). Neither is imported here:
 * Local Books is a standalone binary whose runtime dependencies are deliberately
 * three pure-TS packages (ADR-0072), the `packages/data` encoder is explicitly
 * private authority mechanics no consumer may freeze as a contract, and this
 * gate needs ~30 lines rather than a protocol-grade admission checker. The
 * digest itself is `node:crypto`, which Bun implements natively and compiles
 * into the single binary, so nothing here is hand-rolled cryptography.
 */

import { createHash } from 'node:crypto';

/**
 * The JSON shapes this encoder accepts. A declaration is plain data by
 * construction, so anything outside this type is a caller bug and throws rather
 * than acquiring a silent representation.
 */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

/**
 * Serialize a JSON value so that equal meaning yields equal bytes: object keys
 * sorted by UTF-16 code unit (what `<` compares, so no locale collation enters),
 * arrays kept in order (array order *is* meaning), and no whitespace. This is
 * the JSON Canonicalization Scheme (RFC 8785) restricted to what a declaration
 * can contain.
 *
 * Arrays staying ordered is the one asymmetry worth stating: a reordered record
 * of entities means nothing, so the declaration sorts those into an array before
 * it gets here, while a reordered column list is a different table and must
 * change the digest.
 */
export function canonicalJson(value: JsonValue): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string')
		return JSON.stringify(value);
	if (typeof value === 'number') {
		if (!Number.isFinite(value))
			throw new TypeError('Canonical JSON accepts only finite numbers');
		return JSON.stringify(value);
	}
	if (Array.isArray(value))
		return `[${value.map((child) => canonicalJson(child)).join(',')}]`;
	if (typeof value === 'object') {
		return `{${Object.entries(value)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
			.join(',')}}`;
	}
	throw new TypeError('Canonical JSON accepts only finite JSON values');
}

/** The NUL separator between a digest's domain tag and its canonical payload. */
const DOMAIN_SEPARATOR = '\u0000';

/**
 * SHA-256, lowercase hex, over `<domain>\0<canonical JSON>`.
 *
 * The domain is the caller's type-and-version tag, separated by a NUL byte,
 * which canonical JSON can never emit unescaped. So two different kinds of
 * declaration cannot collide by hashing to the same string, and bumping the
 * version inside the domain is itself a way to force a rebuild without touching
 * the declaration.
 */
export function fingerprint(domain: string, value: JsonValue): string {
	return createHash('sha256')
		.update(`${domain}${DOMAIN_SEPARATOR}${canonicalJson(value)}`, 'utf8')
		.digest('hex');
}
