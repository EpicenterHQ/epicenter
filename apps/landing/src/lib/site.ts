/** The addresses and figures the public site states out loud, in one place. */

export const SITE_ORIGIN = 'https://epicenter.so';

/** Braden's personal site. Every article republished here permanently lives there. */
export const CANONICAL_HOME = 'https://bradenwong.com';

export const GITHUB_REPO = 'https://github.com/EpicenterHQ/epicenter';
export const DISCORD = 'https://go.epicenter.so/discord';
export const WHISPERING_APP = 'https://whispering.epicenter.so';

/**
 * The most recent public release, which is a Whispering release. There is no
 * Epicenter download, and the site must never imply one. Update this when a
 * release ships; it is stated with its date so a stale figure reads as old news
 * rather than as a current claim.
 */
export const LATEST_RELEASE = {
	app: 'Whispering',
	version: 'v7.11.0',
	releasedOn: '2025-12-27',
	url: `${GITHUB_REPO}/releases/tag/v7.11.0`,
} as const;

/** The day the "what runs today" ledger was last checked against the repository. */
export const LEDGER_CHECKED_ON = '2026-07-30';

/**
 * The decision records the site points at. Epicenter writes its durable
 * decisions down and keeps the arguments that produced them, which is the only
 * reason a page like this can send a skeptical reader somewhere better than
 * itself.
 *
 * `status` is stated everywhere a record is linked. Several of the storage
 * records are still proposals, and a site that blurs a proposal into a shipped
 * guarantee has lied about the one thing it is here to be trusted on.
 */
export const ADRS = {
	oneEpicenter: {
		file: '0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary',
		status: 'Proposed',
	},
	lenses: {
		file: '0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes',
		status: 'Proposed',
	},
	portable: {
		file: '0167-a-portable-epicenter-is-an-identity-free-export-of-one-authority-cut',
		status: 'Proposed',
	},
	storage: {
		file: '0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes',
		status: 'Proposed',
	},
	blobs: {
		file: '0173-each-row-owns-at-most-one-write-once-immutable-blob',
		status: 'Proposed',
	},
	inspection: {
		file: '0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql',
		status: 'Accepted',
	},
	installedApps: {
		file: '0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary',
		status: 'Accepted',
	},
	appClient: {
		file: '0186-an-app-reaches-epicenter-through-one-bundled-mit-client-it-installs-itself',
		status: 'Accepted',
	},
	plaintextRelay: {
		file: '0004-trust-the-relay-reject-zero-knowledge',
		status: 'Accepted',
	},
	privacyIsDeployment: {
		file: '0068-privacy-is-a-deployment-not-a-product-feature',
		status: 'Accepted',
	},
} as const;

export function adrUrl(record: { file: string }): string {
	return `${GITHUB_REPO}/blob/main/docs/adr/${record.file}.md`;
}

/**
 * One absolute URL per page, with the trailing slash Astro's directory output
 * actually serves. Canonical, og:url, and the sitemap all read from here, so
 * they cannot disagree about what this page is called.
 */
export function absoluteUrl(pathname: string): string {
	const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
	if (path === '/') return `${SITE_ORIGIN}/`;
	const withoutTrailing = path.replace(/\/+$/, '');
	return `${SITE_ORIGIN}${withoutTrailing}/`;
}

/** How dates are spoken on this site: unambiguous, and the same everywhere. */
export function formatDay(day: string | Date): string {
	const date = typeof day === 'string' ? new Date(`${day}T12:00:00Z`) : day;
	return date.toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		timeZone: 'UTC',
	});
}
