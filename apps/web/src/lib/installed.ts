/**
 * The apps a person has installed (ADR-0694): a record only the person
 * changes, kept on this device until accounts keep it, never a file in a
 * repository (anything that writes files could then install code). A new
 * device starts with the default apps, installed by the same `install`
 * any other app goes through.
 *
 * Each entry pins the bundle by its hash. A first-party bundle is compiled
 * into the shell, so its hash is the hash of its source as built
 * (`__BUNDLE_HASHES__`), recorded but not enforced: the shell can only run
 * the code it carries.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';

/** An installed app: the hostname that identifies it, its name, the hash of the bundle installed, and when. */
export type InstalledApp = {
	hostname: string;
	name: string;
	hash: string;
	installedAt: string;
};

/** What the record is kept as. */
type Stored = { version: 1; apps: InstalledApp[] };

/** Where the record is kept: `localStorage`, or a stand-in. */
export type RecordStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** A bundle an install can pin: its name and hash, by hostname. */
export type Installable = { name: string; hash: string };

export const RECORD_KEY = 'epicenter:installed-apps';

const isApp = (value: unknown): value is InstalledApp => {
	if (typeof value !== 'object' || value === null) return false;
	const app = value as Record<string, unknown>;
	return ['hostname', 'name', 'hash', 'installedAt'].every(
		(key) => typeof app[key] === 'string',
	);
};

/** The record as kept, or null when there is none or it does not read as one. */
function read(storage: RecordStorage): InstalledApp[] | null {
	const text = storage.getItem(RECORD_KEY);
	if (text === null) return null;
	try {
		const parsed = JSON.parse(text) as Partial<Stored>;
		return parsed.version === 1 &&
			Array.isArray(parsed.apps) &&
			parsed.apps.every(isApp)
			? parsed.apps
			: null;
	} catch {
		return null;
	}
}

/**
 * The installed apps over `storage`. `installable` says what a hostname
 * installs as, or undefined when this shell cannot install it. With no
 * record (a new device), or one that does not read, the default apps are
 * installed first.
 */
export function openInstalled({
	storage,
	installable,
	defaults,
	now = () => new Date(),
}: {
	storage: RecordStorage;
	installable: (hostname: string) => Installable | undefined;
	defaults: readonly string[];
	now?: () => Date;
}) {
	let apps: InstalledApp[] = read(storage) ?? [];
	const save = () =>
		storage.setItem(
			RECORD_KEY,
			JSON.stringify({ version: 1, apps } satisfies Stored),
		);

	/** Install the app at `hostname`, pinned to the hash of the bundle this shell has for it; installing one already installed changes nothing. */
	function install(hostname: string): Result<InstalledApp, string> {
		const known = apps.find((app) => app.hostname === hostname);
		if (known !== undefined) return Ok(known);
		const bundle = installable(hostname);
		if (bundle === undefined)
			return Err(
				`Installing an app from ${hostname} is not built yet: only Epicenter's own apps install.`,
			);
		const app: InstalledApp = {
			hostname,
			name: bundle.name,
			hash: bundle.hash,
			installedAt: now().toISOString(),
		};
		apps = [...apps, app];
		save();
		return Ok(app);
	}

	if (read(storage) === null)
		for (const hostname of defaults) install(hostname);

	return {
		/** Every installed app, in the order installed. */
		apps: (): readonly InstalledApp[] => apps,
		install,
		/** Read the record again, as another tab may have changed it. */
		reload() {
			apps = read(storage) ?? apps;
		},
	};
}
