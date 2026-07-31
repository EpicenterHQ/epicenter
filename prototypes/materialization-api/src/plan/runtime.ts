/**
 * Prototype B's runtime owner (ADR-0176's second owner, applied to
 * materializations instead of indexes).
 *
 * The app names a *principal*. It never names a path. That single move makes
 * four prose rules mechanical:
 *
 *   - ADR-0192 clause E, credentials never inside a mirror directory: the app
 *     cannot put them there because it chooses neither location.
 *   - ADR-0192 clause G, one directory per upstream principal at 0700: by
 *     construction, not by each app remembering.
 *   - Two principals cannot collide, because one principal maps to one dir.
 *   - Backup visibility: the runtime places materializations in cache-class
 *     storage, so "a disposable store is not swept into Time Machine" needs no
 *     per-app exclusion call and no rule anyone has to remember.
 *
 * The runtime is a plain value, not a service. ADR-0072 requires Local Books to
 * run as a standalone dependency-light binary with no Epicenter host present,
 * and ADR-0192 rejected host-owned mirroring outright. A value satisfies both:
 * a CLI constructs its own, and Epicenter Home passes its own.
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type StoreRef = {
	/** Which materialization family: `books`, `mail`, `photos`. */
	family: string;
	/** The upstream principal: a realm id, a mailbox address, a company. */
	principal: string;
};

export type StoreLocation = StoreRef & {
	readonly dir: string;
	readonly dbPath: string;
	readonly leasePath: string;
	/**
	 * Cache-class storage. Not a hint: the runtime chose a root that generic
	 * backup tools skip, which is the whole of the answer to "should a
	 * materialization be backed up".
	 */
	readonly storageClass: 'cache';
};

export type Runtime = {
	readonly cacheRoot: string;
	readonly dataRoot: string;
	/** Where a materialization physically lives. Creates the directory at 0700. */
	locate(ref: StoreRef): StoreLocation;
	/**
	 * Where a principal's credential lives: under the data root, never under
	 * the cache root, so a read-only SQL surface over the store cannot reach it
	 * even with a path traversal.
	 */
	credentialPath(ref: StoreRef): string;
};

/**
 * OS conventions, split by *durability class* rather than by app. Application
 * Support is backed up and holds what a person would lose; Caches is not backed
 * up and holds what can be recomputed. A materialization is the second kind.
 */
export function defaultRoots(appName: string): {
	cacheRoot: string;
	dataRoot: string;
} {
	if (process.platform === 'darwin') {
		return {
			cacheRoot: join(homedir(), 'Library', 'Caches', appName),
			dataRoot: join(homedir(), 'Library', 'Application Support', appName),
		};
	}
	const cacheHome = process.env['XDG_CACHE_HOME'];
	const dataHome = process.env['XDG_DATA_HOME'];
	return {
		cacheRoot: join(
			cacheHome && cacheHome.length > 0 ? cacheHome : join(homedir(), '.cache'),
			appName,
		),
		dataRoot: join(
			dataHome && dataHome.length > 0
				? dataHome
				: join(homedir(), '.local', 'share'),
			appName,
		),
	};
}

/** Principals are provider-chosen strings; they must never escape their root. */
function principalSegment(principal: string): string {
	if (
		principal.length === 0 ||
		!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(principal)
	) {
		throw new TypeError(
			`Refusing ${JSON.stringify(principal)} as a principal directory segment`,
		);
	}
	return principal;
}

export function createRuntime({
	cacheRoot,
	dataRoot,
}: {
	cacheRoot: string;
	dataRoot: string;
}): Runtime {
	function ensureDir(path: string): string {
		mkdirSync(path, { recursive: true, mode: 0o700 });
		chmodSync(path, 0o700);
		return path;
	}

	return {
		cacheRoot,
		dataRoot,
		locate(ref) {
			const dir = ensureDir(
				join(
					cacheRoot,
					'materializations',
					ref.family,
					principalSegment(ref.principal),
				),
			);
			return {
				...ref,
				dir,
				dbPath: join(dir, 'store.sqlite3'),
				leasePath: join(dir, 'sync.lease'),
				storageClass: 'cache',
			};
		},
		credentialPath(ref) {
			ensureDir(join(dataRoot, 'credentials', ref.family));
			return join(
				dataRoot,
				'credentials',
				ref.family,
				`${principalSegment(ref.principal)}.json`,
			);
		},
	};
}
