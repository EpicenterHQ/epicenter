/**
 * The Ark publisher kernel: the one owner of how a rendered projection
 * becomes public bytes.
 *
 * This module is trusted, private-side code. It is NOT imported by the public
 * Worker entry (src/index.ts), so the deployed public plane keeps zero write
 * paths; the kernel runs wherever an authenticated caller holds bucket
 * credentials (an operator CLI today, an authenticated endpoint only if one
 * is ever earned). The object store is injected so the whole orchestration is
 * provable in-memory without credentials or production resources.
 *
 * Invariants owned here, and nowhere else:
 * - Reserve-first, atomically: a publicly-unroutable `.artifact` marker
 *   claims the `<identity>/<slug>` subtree via create-if-absent before any
 *   public byte lands, so two racing publishers cannot both win. The marker
 *   records the private artifact id AND the immutable expression digest
 *   (Vault ADR-0064: idempotent inserts key on the expression digest, never
 *   `integrity_digest`). It is the entire collision registry: another
 *   artifact is refused the slug forever; the same artifact with a different
 *   frozen expression is refused (a permalink never changes its words); only
 *   an exact match converges. Generated HTML and media are deliberately NOT
 *   hashed, so theme rebuilds and free output rebuilds stay allowed.
 * - Route-last: generated media is written before `index.html`, so the page
 *   address only ever answers with its media already in place.
 * - Verification boundary: a resolved `put` IS the write proof. The store
 *   contract requires a checked durable write (have R2 verify a content
 *   checksum server-side; never a kernel re-download of regenerable bytes).
 *   End-to-end proof stays with the caller, which fetches the expected
 *   canonical public URL after the kernel returns (the Vault port's
 *   contract).
 * - Route agreement: keys are derived through the delivery Worker's own
 *   `resolveProjection`, so the kernel cannot write an object the Worker
 *   would refuse to serve.
 */
import { resolveProjection } from './index';
import {
	type ArkArtifactPage,
	type ArkMediaSet,
	renderArtifactPage,
} from './render';

/**
 * The minimal R2-shaped write contract the kernel needs. An `R2Bucket`
 * satisfies it with a thin adapter; tests satisfy it with a Map.
 */
export type ArkObjectStore = {
	get(key: string): Promise<Uint8Array | null>;
	/**
	 * Durable checked write: resolve only after the backing store confirmed
	 * the write succeeded. Adapters should pass a content checksum (R2 `md5`,
	 * S3 `Content-MD5`) so the store verifies the bytes server-side; the
	 * kernel never re-reads objects to prove its own writes.
	 */
	put(
		key: string,
		value: Uint8Array,
		options: { contentType: string },
	): Promise<void>;
	/**
	 * Atomic create-if-absent; resolves false when the key already exists,
	 * without touching the stored value. On R2 this is
	 * `put(key, value, { onlyIf: { etagDoesNotMatch: '*' }, ... }) !== null`
	 * (a failed precondition resolves null instead of writing).
	 */
	createExclusive(
		key: string,
		value: Uint8Array,
		options: { contentType: string },
	): Promise<boolean>;
};

/** Generated media bytes, keyed by the renderer's closed media vocabulary. */
export type ArkMediaFiles = {
	readonly [Name in keyof ArkMediaSet]?: Uint8Array;
};

const MEDIA_OBJECTS = [
	['video', 'video.mp4', 'video/mp4'],
	['narration', 'narration.mp3', 'audio/mpeg'],
	['cover', 'cover.png', 'image/png'],
] as const;

export type ArkPublication = {
	/** Private artifact identity for ownership; never appears in public routes. */
	readonly artifactId: string;
	/**
	 * The immutable expression-and-production-input digest (64 lowercase hex)
	 * from Vault ADR-0064. It identifies the exact frozen expression, so a
	 * retry converges and changed words are refused. Never `integrity_digest`
	 * (a checklist-bound state checksum), and never a hash of generated
	 * HTML/media (rebuilds must stay free).
	 */
	readonly expressionDigest: string;
	/** The page input, minus `media`, which is derived from `files` here. */
	readonly page: Omit<ArkArtifactPage, 'media'>;
	readonly files?: ArkMediaFiles;
};

export type PublishedProjection = {
	readonly url: string;
	/** The first reservation's date; exact retries preserve this value. */
	readonly publishedOn: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What the ownership marker records about the slug's one publication. */
type MarkerFacts = {
	readonly artifact: string;
	readonly expression: string;
	readonly publishedOn: string;
};

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseMarker(key: string, bytes: Uint8Array): MarkerFacts {
	let parsed: unknown;
	try {
		parsed = JSON.parse(decoder.decode(bytes));
	} catch {
		throw new Error(
			`${key}: unrecognized ownership marker; refusing to publish over it`,
		);
	}
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		typeof (parsed as MarkerFacts).artifact !== 'string' ||
		typeof (parsed as MarkerFacts).expression !== 'string' ||
		typeof (parsed as MarkerFacts).publishedOn !== 'string' ||
		!DATE_PATTERN.test((parsed as MarkerFacts).publishedOn)
	) {
		throw new Error(
			`${key}: unrecognized ownership marker; refusing to publish over it`,
		);
	}
	const { artifact, expression, publishedOn } = parsed as MarkerFacts;
	return { artifact, expression, publishedOn };
}

/**
 * Refuse unless the recorded owner is exactly this artifact and this frozen
 * expression. Anything else is permanent: another artifact never takes over
 * a permalink, and the same artifact never changes its published words.
 */
function assertSameOwner(
	pageAddress: string,
	recorded: MarkerFacts,
	claim: MarkerFacts,
): void {
	if (recorded.artifact !== claim.artifact) {
		throw new Error(
			`${pageAddress}: already published by another artifact (${recorded.artifact}); a frozen permalink is never reassigned`,
		);
	}
	if (recorded.expression !== claim.expression) {
		throw new Error(
			`${pageAddress}: artifact ${claim.artifact} is already published with a different frozen expression (${recorded.expression}); a permalink never changes its words`,
		);
	}
}

/**
 * Render and publish one frozen artifact projection. Idempotent for the same
 * artifact id and expression digest; refuses the slug for anything else.
 * Throws on any violated invariant; a throw after the marker is written
 * leaves a reserved, retryable subtree and never a half-activated page over
 * wrong media.
 */
export async function publishProjection(
	store: ArkObjectStore,
	publication: ArkPublication,
): Promise<PublishedProjection> {
	const { artifactId, expressionDigest, page, files } = publication;

	if (!DIGEST_PATTERN.test(expressionDigest)) {
		throw new Error(
			`${artifactId}: expressionDigest must be 64 lowercase hex characters (Vault ADR-0064 expression digest, not integrity_digest)`,
		);
	}
	if (!DATE_PATTERN.test(page.publishedOn)) {
		throw new Error(
			`${artifactId}: publishedOn must be a YYYY-MM-DD calendar date`,
		);
	}

	// Route agreement: the delivery Worker's resolver is the single truth for
	// which addresses exist. Anything it refuses, the kernel refuses to write.
	const pageAddress = `/${page.identity}/${page.slug}`;
	const resolved = resolveProjection(pageAddress);
	if (!resolved?.isPage) {
		throw new Error(
			`${pageAddress}: not a servable artifact address (lowercase-hyphenated identity and slug required)`,
		);
	}

	// Reserve-first, atomically. The marker name is publicly unroutable by
	// construction: the Worker's closed media vocabulary can never name
	// `.artifact`, so the ownership marker cannot be fetched through the
	// public plane.
	const claim: MarkerFacts = {
		artifact: artifactId,
		expression: expressionDigest,
		publishedOn: page.publishedOn,
	};
	const markerKey = `${page.identity}/${page.slug}/.artifact`;
	const markerBytes = encoder.encode(JSON.stringify(claim));

	let reservation: MarkerFacts;
	const existingMarker = await store.get(markerKey);
	if (existingMarker) {
		reservation = parseMarker(markerKey, existingMarker);
		assertSameOwner(pageAddress, reservation, claim);
	} else {
		const created = await store.createExclusive(markerKey, markerBytes, {
			contentType: 'application/json',
		});
		if (created) {
			reservation = claim;
		} else {
			// Lost the creation race. The winner is authoritative: converge if
			// it was our own duplicate retry, refuse anything else.
			const winner = await store.get(markerKey);
			if (!winner) {
				throw new Error(`${markerKey}: reservation race could not be resolved`);
			}
			reservation = parseMarker(markerKey, winner);
			assertSameOwner(pageAddress, reservation, claim);
		}
	}

	// Media before the page, so activation is route-last.
	const media: { video?: boolean; narration?: boolean; cover?: boolean } = {};
	for (const [name, fileName, contentType] of MEDIA_OBJECTS) {
		const bytes = files?.[name];
		if (!bytes) continue;
		const fileAddress = `${pageAddress}/${fileName}`;
		const resolvedFile = resolveProjection(fileAddress);
		if (!resolvedFile) {
			throw new Error(`${fileAddress}: not a servable media address`);
		}
		await store.put(resolvedFile.key, bytes, { contentType });
		media[name] = true;
	}

	const html = renderArtifactPage({
		...page,
		publishedOn: reservation.publishedOn,
		media,
	});
	await store.put(resolved.key, encoder.encode(html), {
		contentType: 'text/html; charset=utf-8',
	});

	return {
		url: `https://theark.so${pageAddress}`,
		publishedOn: reservation.publishedOn,
	};
}
