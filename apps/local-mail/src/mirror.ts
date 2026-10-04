/**
 * A mirror is a deterministic, disposable SQLite materialization of an
 * application-owned declaration. Its fingerprint names the current artifact:
 * `<name>.<fingerprint>.db`. A declaration edit is not an event the opener
 * handles, it is a different filename, so opening never drops, truncates,
 * migrates, or unlinks anything. See ADR-0194.
 *
 *     const mirror = defineMirror({ name: 'mail', declaration });
 *     const site = mirror.at(companyDir);
 *     site.open();               // writable, created if absent
 *     site.openReadonly();       // read-only, `null` when absent
 *     site.artifacts();          // what exists here, and which one is current
 *     site.reclaim(fingerprint); // delete one non-current artifact + sidecars
 *
 * `name` and `declaration` are the only inputs: no realm, domain, authority
 * identifier, filename override, or path template. The caller picks the
 * directory by passing it to `at()`, which is where per-tenant naming lives.
 *
 * This module owns canonical declaration hashing, the filename grammar, path
 * construction, artifact inspection, the two opening modes, and grammar-scoped
 * deletion. It owns nothing else: DDL, ingestion, cursors, "is the replacement
 * usable yet", locking, file permissions, and cleanup timing all stay with the
 * application. It deliberately imports nothing from this app.
 *
 * This file is deliberately the same file as `apps/local-books/src/mirror.ts`,
 * not a Mail variant of it. ADR-0194 defers extracting the primitive into a
 * package until a second app adopts it without pushing a knob into it, and this
 * is that second adoption: Mail's harder requirements (0700/0600 permissions, a
 * `lock.db` sibling, a paginated backfill) are all satisfied around this surface
 * rather than inside it. Keeping the two copies identical is what makes the
 * eventual extraction a move rather than a merge, so an edit here that Books
 * does not also want belongs in Mail's code, not in this file.
 */

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What a declaration may contain. Deliberately narrow: the fingerprint answers
 * exactly one question ("is the stored shape the same shape as before"), and it
 * can only answer it if every value has one canonical serialization. Anything
 * outside this set (a `Date`, a `Map`, a class instance, a function, `undefined`,
 * `NaN`) is rejected at `defineMirror` time rather than hashed by accident.
 */
export type DeclarationValue =
	| string
	| number
	| boolean
	| null
	| readonly DeclarationValue[]
	| { readonly [key: string]: DeclarationValue };

/** One materialization present at a site. */
export type MirrorArtifact = {
	fingerprint: string;
	filename: string;
	path: string;
	/** Whether this artifact is the one the live declaration names. */
	current: boolean;
};

export type MirrorSite = {
	/** The live declaration's fingerprint: the artifact this site reads and writes. */
	readonly fingerprint: string;
	/** The current artifact's path, whether or not it exists yet. */
	readonly path: string;
	/**
	 * Every artifact of this mirror at this directory, oldest name first, with
	 * `current` marking the one the live declaration names. Reads the directory
	 * only: no SQLite handle is opened, so a predecessor written by a future build
	 * is still listed. An absent directory is an empty site, not an error.
	 */
	artifacts(): MirrorArtifact[];
	/**
	 * A writable handle on the current artifact, creating the directory and the
	 * file if either is absent, with the concurrency contract applied. Creates
	 * nothing else and destroys nothing: the worst a mistaken writable open can do
	 * is leave an empty file behind.
	 */
	open(): Database;
	/**
	 * A read-only handle on the current artifact, or `null` when it does not exist.
	 * Never creates a file, and never opens a predecessor: the moment the
	 * declaration changes the predecessor stops being authoritative. A caller that
	 * wants to inspect one takes its path from `artifacts()` and opens it itself.
	 */
	openReadonly(): Database | null;
	/**
	 * Delete one non-current artifact and its `-wal` / `-shm` sidecars, and nothing
	 * else. Refuses the current fingerprint and anything that is not 64 hex
	 * characters, never touches a path the filename grammar does not produce (so a
	 * sibling `lock.db` or `credentials.json` is unreachable), and never removes
	 * the directory. Reclaiming an artifact that is already gone is a no-op.
	 *
	 * There is no completion protocol here: the primitive cannot know whether a
	 * successor has been re-pulled, so the application calls this once it decides
	 * the replacement is usable.
	 */
	reclaim(fingerprint: string): void;
};

export type Mirror = {
	readonly name: string;
	readonly fingerprint: string;
	/** The mirror as materialized under one directory. */
	at(directory: string): MirrorSite;
};

/**
 * Lowercase hyphenated, so the name is safe in a filename on every platform and
 * cannot collide with the `.` separators or the hex fingerprint.
 */
const MIRROR_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** SHA-256, lowercase hex. */
const FINGERPRINT = /^[0-9a-f]{64}$/;

/**
 * Prefixed onto every canonical serialization before hashing. Owned here rather
 * than supplied by the app, so two mirrors that declare the same shape hash the
 * same and a future change to this serialization can announce itself by bumping
 * the tag.
 */
const FORMAT_TAG = 'epicenter.mirror.declaration.v1';

/** SQLite's sidecars, deleted alongside the artifact they belong to. */
const SIDECARS = ['-wal', '-shm'] as const;

const BUSY_TIMEOUT_MS = 5000;

/** A plain object, i.e. an object literal rather than a class instance. */
function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * The declaration as one canonical string: object keys sorted, array order
 * preserved, and every unsupported value rejected rather than coerced. Object
 * insertion order must not become rebuild behavior, which is why this exists
 * instead of `JSON.stringify`, and why `toJSON` is never consulted.
 *
 * `path` names the offending site in the thrown message, because a declaration
 * is authored by hand and a rejection is a bug to fix, not a state to handle.
 */
function canonicalize(value: unknown, path: string, seen: Set<object>): string {
	if (value === null) return 'null';
	switch (typeof value) {
		case 'boolean':
			return value ? 'true' : 'false';
		case 'number':
			if (!Number.isFinite(value)) {
				throw new Error(`Declaration value at ${path} is not a finite number.`);
			}
			return JSON.stringify(value);
		case 'string':
			return JSON.stringify(value);
		case 'object':
			break;
		default:
			throw new Error(
				`Declaration value at ${path} is ${typeof value}; a declaration holds only strings, finite numbers, booleans, null, arrays, and plain objects.`,
			);
	}

	const object = value as object;
	if (seen.has(object)) {
		throw new Error(`Declaration value at ${path} is cyclic.`);
	}
	seen.add(object);
	try {
		if (Array.isArray(object)) {
			return `[${object
				.map((item, i) => canonicalize(item, `${path}[${i}]`, seen))
				.join(',')}]`;
		}
		if (!isPlainObject(object)) {
			throw new Error(
				`Declaration value at ${path} is a ${object.constructor?.name ?? 'non-plain'} instance; a declaration holds only plain objects.`,
			);
		}
		const entries = Object.keys(object)
			.sort()
			.map((key) => {
				const own = (object as Record<string, unknown>)[key];
				if (own === undefined) {
					throw new Error(
						`Declaration value at ${path}.${key} is undefined; omit the key or declare it null.`,
					);
				}
				return `${JSON.stringify(key)}:${canonicalize(own, `${path}.${key}`, seen)}`;
			});
		return `{${entries.join(',')}}`;
	} finally {
		seen.delete(object);
	}
}

/** SHA-256 of the tagged canonical serialization, lowercase hex. */
function fingerprintOf(declaration: DeclarationValue): string {
	const canonical = canonicalize(declaration, '<declaration>', new Set());
	return createHash('sha256')
		.update(`${FORMAT_TAG}\n${canonical}`)
		.digest('hex');
}

/**
 * Declare a mirror: a name for its artifacts and the shape they hold. The
 * fingerprint is computed here, so a declaration this module cannot canonically
 * serialize fails at module load rather than at the first open.
 *
 * `name` is not a fingerprint input. It is already in the filename, so hashing it
 * would make the fingerprint a statement about naming rather than about shape. A
 * rename still produces a new artifact, and still costs a full rebuild.
 */
export function defineMirror({
	name,
	declaration,
}: {
	name: string;
	declaration: DeclarationValue;
}): Mirror {
	if (!MIRROR_NAME.test(name)) {
		throw new Error(
			`Mirror name "${name}" must be lowercase alphanumeric words joined by single hyphens.`,
		);
	}
	const fingerprint = fingerprintOf(declaration);
	const artifactPattern = new RegExp(`^${name}\\.([0-9a-f]{64})\\.db$`);
	const filenameFor = (of: string) => `${name}.${of}.db`;

	return {
		name,
		fingerprint,
		at(directory: string): MirrorSite {
			const path = join(directory, filenameFor(fingerprint));
			return {
				fingerprint,
				path,

				artifacts(): MirrorArtifact[] {
					let filenames: string[];
					try {
						filenames = readdirSync(directory);
					} catch {
						return [];
					}
					return filenames
						.map((filename) => ({
							filename,
							found: artifactPattern.exec(filename)?.[1],
						}))
						.filter(
							(entry): entry is { filename: string; found: string } =>
								entry.found !== undefined,
						)
						.sort((a, b) => (a.filename < b.filename ? -1 : 1))
						.map(({ filename, found }) => ({
							fingerprint: found,
							filename,
							path: join(directory, filename),
							current: found === fingerprint,
						}));
				},

				open(): Database {
					mkdirSync(directory, { recursive: true });
					const db = new Database(path, { create: true });
					// The concurrency contract both writers share. WAL so readers never
					// block the writer; a busy_timeout so a second writer waits for the
					// lock instead of failing instantly with SQLITE_BUSY; synchronous
					// NORMAL because a mirror is re-pullable by construction, so a lost
					// last commit on power loss costs a re-pull and nothing more.
					db.run('PRAGMA journal_mode = WAL;');
					db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
					db.run('PRAGMA synchronous = NORMAL;');
					db.run('PRAGMA foreign_keys = ON;');
					return db;
				},

				openReadonly(): Database | null {
					if (!existsSync(path)) return null;
					const db = new Database(path, { readonly: true });
					// No journal-mode change and no other persistent pragma: a reader
					// touches nothing. The timeout is per-connection, so it still applies.
					db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
					return db;
				},

				reclaim(of: string): void {
					if (!FINGERPRINT.test(of)) {
						throw new Error(
							`Cannot reclaim "${of}": a fingerprint is 64 lowercase hex characters.`,
						);
					}
					if (of === fingerprint) {
						throw new Error(
							`Cannot reclaim ${of}: it is the current artifact of mirror "${name}".`,
						);
					}
					const target = join(directory, filenameFor(of));
					// Sidecars first, the artifact last: an interrupted reclaim then
					// leaves a readable database rather than an orphaned write-ahead log
					// that a later artifact of the same name would find beside it.
					for (const suffix of SIDECARS) {
						rmSync(`${target}${suffix}`, { force: true });
					}
					rmSync(target, { force: true });
				},
			};
		},
	};
}
