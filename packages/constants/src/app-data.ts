/**
 * Where Epicenter stores things on a machine.
 *
 * Epicenter owns exactly one application-data root. Every trusted app it runs or
 * admits receives one directory below it. Epicenter owns the installed bundle
 * below that directory, while the app owns its data and device stores, which
 * may be opened through host capabilities. See ADR-0358.
 *
 * Three parties choose names along that path, and each function below is one
 * hand-off between two of them: Epicenter names the root and its own
 * directories, an app names everything in its directory, and an external
 * authority names a partition. `apps/` and the partition-kind directory exist
 * because a directory whose next name is chosen by somebody else cannot be
 * defended by the party that would have to defend it. There is no level here
 * that is not one of those hand-offs.
 *
 * These are pure functions over strings and a grammar. There is no store, no
 * handle, no registry of app directories, and no lifecycle: allocating a place
 * is naming it, not owning a store. Storage capabilities own the lifecycle of
 * the specific stores they open below an app directory.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Production desktop identity used by standalone CLI defaults. */
export const EPICENTER_BUNDLE_IDENTIFIER = 'so.epicenter';

/**
 * Re-exported so that everything naming an app directory reads one grammar,
 * and so the page-side half of the storage protocol can import it without
 * pulling `node:os` in behind it.
 */
export { isAppId } from './app-id.js';

import { isAppId } from './app-id.js';

/**
 * The ambient inputs the root is computed from, passed as a value so the
 * platform table below is a unit test rather than a machine you have to own.
 * Defaults to this process.
 */
export type DataRootSystem = {
	env: Record<string, string | undefined>;
	platform: string;
	homeDir: string;
};

/**
 * The one Epicenter application-data root. `EPICENTER_DATA_DIR` wins, for tests
 * and for a person who wants their data elsewhere; an empty value counts as
 * unset and a relative one is refused, for the same reason a relative
 * `XDG_DATA_HOME` is ignored below.
 *
 * Standalone CLIs default to production storage. The desktop does not call
 * this resolver: native startup selects its paths from the running identity
 * and passes them to Bun. A CLI targeting development uses the explicit override.
 * Defaults follow Tauri's local-data locations on macOS, Linux, and Windows.
 */
export function epicenterDataRoot(
	system: DataRootSystem = {
		env: process.env,
		platform: process.platform,
		homeDir: homedir(),
	},
): string {
	const override = system.env.EPICENTER_DATA_DIR;
	if (override && override.length > 0) {
		// A relative override would resolve against the working directory, so a CLI
		// run from two places would see two roots while the desktop host saw a
		// third: the exact drift a relative `XDG_DATA_HOME` is ignored for. It is
		// refused rather than resolved because that would read a fourth ambient
		// input this function deliberately does not take.
		if (!isAbsolute(override)) {
			throw new Error(
				`EPICENTER_DATA_DIR must be an absolute path, not ${JSON.stringify(override)}.`,
			);
		}
		return override;
	}
	return join(localDataDir(system), EPICENTER_BUNDLE_IDENTIFIER);
}

function localDataDir({ env, platform, homeDir }: DataRootSystem): string {
	if (platform === 'darwin') {
		return join(homeDir, 'Library', 'Application Support');
	}
	if (platform === 'win32') {
		const localAppData = env.LOCALAPPDATA;
		// `dirs` asks Windows for FOLDERID_LocalAppData and yields nothing when
		// that fails, which Tauri turns into an error. Guessing a path here would
		// silently put a person's mail somewhere their host is not looking, so
		// this fails the same way rather than inventing a fallback.
		if (!localAppData || localAppData.length === 0) {
			throw new Error(
				'LOCALAPPDATA is not set, so the Epicenter data root cannot be resolved. Set EPICENTER_DATA_DIR to name it explicitly.',
			);
		}
		return localAppData;
	}
	const xdg = env.XDG_DATA_HOME;
	// Absolute only, matching `dirs`. A relative XDG_DATA_HOME would otherwise
	// resolve against the working directory, so a CLI run from two places would
	// see two roots while the desktop host saw a third.
	if (xdg && isAbsolute(xdg)) return xdg;
	return join(homeDir, '.local', 'share');
}

/**
 * An app's one directory: `<root>/apps/<appId>`. The host owns the installed
 * `bundle/` below it; the app owns its data and device stores. This function
 * names the shared app boundary, not a permission capability (ADR-0358).
 *
 * `apps/` is where naming authority changes hands. Above it Epicenter chooses
 * the names. Below an app id, the bundle and the app's stores have separate
 * owners. One segment keeps a host directory added later from landing on an
 * app id, and the host's promise is stated against that explicit split.
 *
 * Allocation is nominal: this names a place and creates nothing. A directory
 * exists exactly when its owner writes into it, the same rule
 * {@link partitionDir} follows one level down, which is why every trusted app
 * having one costs nothing to run.
 *
 * The result is a string, injected at the owner's composition root the way the
 * sidecar already computes `join(root, 'data')` and `join(root, 'blobs')`. It is
 * deliberately not a capability: the bytes are not Epicenter's to offer
 * (ADR-0181, ADR-0183).
 *
 * The id is validated because a caller can supply an arbitrary string; only a
 * valid app identifier may name a directory below this root.
 */
export function appDataDir(root: string, appId: string): string {
	if (!isAppId(appId)) {
		throw new Error(
			`The app id ${JSON.stringify(appId)} cannot name a directory.`,
		);
	}
	return join(root, 'apps', appId);
}

/**
 * One partition of an app's directory: `<appDir>/<kind>/<partitionId>`.
 *
 * A partition holds everything scoped to one external account, company, or
 * tenancy, and `partitionId` must be an identifier that external authority
 * issues and never reuses.
 *
 * `kind` is the same hand-off as `apps/`, one altitude down. The app chooses
 * its root filenames (`credentials.json`, `provider.json`) and a provider
 * chooses partition ids, so one directory sits between the two namespaces
 * rather than a reserved-name rule the app would have to enforce against an
 * authority it does not control. The app picks the word (`accounts`,
 * `companies`), because only the app knows what it partitions.
 *
 * Both segments are validated as exactly one path component, which is the only
 * reason this exists rather than a bare `join`: a partition id arrives from a
 * provider callback or a command-line flag, and the Local Books call site this
 * replaced joined `realmId` verbatim.
 *
 * There is no acquisition protocol. A partition exists exactly when its
 * directory does; this function names one and creates nothing.
 */
export function partitionDir(
	appDir: string,
	kind: string,
	partitionId: string,
): string {
	assertOneSegment(kind, 'partition kind');
	assertOneSegment(partitionId, 'partition id');
	return join(appDir, kind, partitionId);
}

function assertOneSegment(segment: string, label: string): void {
	if (
		segment.length === 0 ||
		segment === '.' ||
		segment === '..' ||
		segment.includes('/') ||
		segment.includes('\\')
	) {
		throw new Error(
			`The ${label} ${JSON.stringify(segment)} cannot name a directory.`,
		);
	}
}
