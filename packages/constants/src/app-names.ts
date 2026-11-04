/** Names an app from its declared production site (ADR-0722). */

export type AppEnvironment = 'production' | 'development';
export type AppNameErrorKind =
	| 'invalidSiteUrl'
	| 'invalidIdentifier'
	| 'bareDomain'
	| 'reservedLabel'
	| 'notDevelopmentIdentifier';

export class AppNameError extends Error {
	constructor(
		public readonly kind: AppNameErrorKind,
		value: string,
	) {
		super(`${kind}: ${value}`);
	}
}

const labelPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** A DNS host or label could later name an app or owner in the library. */
export function isClaimableHostName(name: string): boolean {
	if (/[\s\\/@?#:]/.test(name) || name.length === 0) return false;
	let host: string;
	try {
		host = new URL(`https://${name}`).hostname.replace(/\.$/, '');
	} catch {
		return false;
	}
	return (
		host.length <= 253 &&
		host
			.split('.')
			.every((label) => label.length <= 63 && labelPattern.test(label))
	);
}

/** A suggested link name that cannot be claimed by an app or owner. */
export function suggestLibraryLinkName(basename: string): string {
	return isClaimableHostName(basename) ? `${basename} folder` : basename;
}

function labelsFromHost(host: string): [string, string, string, ...string[]] {
	const labels = host.split('.');
	if (labels.some((label) => !labelPattern.test(label)))
		throw new AppNameError('invalidIdentifier', host);
	if (labels.length < 3) throw new AppNameError('bareDomain', host);
	for (const label of labels) {
		if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(label))
			throw new AppNameError('reservedLabel', label);
	}
	return labels as [string, string, string, ...string[]];
}

/** The host of an app's declared HTTPS production origin. */
export function hostFromSiteUrl(siteUrl: string): string {
	let url: URL;
	try {
		url = new URL(siteUrl);
	} catch {
		throw new AppNameError('invalidSiteUrl', siteUrl);
	}
	if (
		url.protocol !== 'https:' ||
		url.port !== '' ||
		url.username !== '' ||
		url.password !== '' ||
		url.pathname !== '/' ||
		url.search !== '' ||
		url.hash !== ''
	)
		throw new AppNameError('invalidSiteUrl', siteUrl);
	labelsFromHost(url.hostname);
	return url.hostname;
}

/** Reverse a bundle identifier, removing `.dev` only for development. */
export function hostFromIdentifier(
	identifier: string,
	environment: AppEnvironment,
): string {
	let site = identifier;
	if (environment === 'development') {
		if (!identifier.endsWith('.dev'))
			throw new AppNameError('notDevelopmentIdentifier', identifier);
		site = identifier.slice(0, -4);
	}
	const labels = site.split('.');
	if (labels.some((label) => !labelPattern.test(label)))
		throw new AppNameError('invalidIdentifier', identifier);
	if (labels.length < 3) throw new AppNameError('bareDomain', identifier);
	const host = labels.reverse().join('.');
	labelsFromHost(host);
	return host;
}

/** A direct Epicenter subdomain is flat; another host uses an owner folder. */
export function relativeFolderPath(host: string): string {
	const labels = labelsFromHost(host);
	if (labels.length === 3 && labels[1] === 'epicenter' && labels[2] === 'so')
		return labels[0];
	return `${labels.slice(1).join('.')}/${labels[0]}`;
}

/** The repository name, without an account or namespace. */
export function repositoryName(host: string): string {
	const labels = labelsFromHost(host);
	if (labels.length === 3 && labels[1] === 'epicenter' && labels[2] === 'so')
		return labels[0];
	return host;
}

/** The reversed host, with `.dev` only for a development build. */
export function appDataIdentifier(
	host: string,
	environment: AppEnvironment,
): string {
	const identifier = labelsFromHost(host).reverse().join('.');
	return environment === 'development' ? `${identifier}.dev` : identifier;
}
