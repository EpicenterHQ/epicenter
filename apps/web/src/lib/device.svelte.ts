/**
 * This browser's repositories, as the shell addresses them, and your home.
 *
 * A repository's address is `/<owner>/<repository>`: the owner is `me` for
 * you (before sign-in, the person using this device; the manifest's `owner`
 * is null), or the owner a link named. `me` is reserved: no owner is named
 * it. Each copy in this browser is a replica
 * (`@epicenter/repository/browser`), listed from its manifest; the shell
 * keeps no list of its own. Every owner's home repository is named `home`;
 * yours, `me/home`, is made the first time it is used.
 */
import {
	BrowserReplicaError,
	createBrowserRepository,
	listBrowserRepositories,
	type Manifest,
	removeBrowserRepository,
} from '@epicenter/repository/browser';
import { Ok, type Result } from 'wellcrafted/result';
import { lens } from './apps.js';
import { NAME } from './name.js';

export type { Manifest };

/** You, in an address: the one reserved owner name. */
export const YOU = 'me';


export { NAME };

/** The address of `manifest`'s repository: `/<owner>/<repository>`. */
export const addressOf = (manifest: Pick<Manifest, 'owner' | 'repository'>) =>
	`/${encodeURIComponent(manifest.owner ?? YOU)}/${encodeURIComponent(manifest.repository)}`;

/** The owner an address segment names: null for you. */
export const ownerOf = (segment: string) => (segment === YOU ? null : segment);

/** What a server takes as whom a request is from: until accounts exist, the development server's `Authorization: Bearer <name>`. */
export const headersOf = (manifest: Pick<Manifest, 'account' | 'url'>): Record<string, string> =>
	manifest.url === null || manifest.account === null ? {} : { authorization: `Bearer ${manifest.account}` };

/** Where a copy keeps its files, in a person's words. */
export const whereOf = (manifest: Manifest) =>
	manifest.url === null ? 'Only on this device' : `Synced with ${new URL(manifest.url).host} as ${manifest.account ?? 'a guest'}`;

/** The link that joins `manifest`'s repository from another browser; null for one kept only here. To others, you are your account on its server. */
export function joinLinkOf(manifest: Manifest, origin: string) {
	if (manifest.url === null) return null;
	const owner = manifest.owner ?? manifest.account ?? YOU;
	const link = new URL(addressOf({ owner, repository: manifest.repository }), origin);
	link.searchParams.set('server', manifest.url);
	return link.href;
}

let listed = $state.raw<Manifest[]>();

/** This browser's repositories, by name, as last listed; undefined until the first listing. */
export const repositories = {
	get current() {
		return listed;
	},
	/** List them again from their manifests. */
	async refresh() {
		listed = (await listBrowserRepositories()).toSorted((a, b) => a.name.localeCompare(b.name) || a.repository.localeCompare(b.repository));
		return listed;
	},
};

/** The copy an address names, among `manifests`. */
export const findAt = (manifests: readonly Manifest[], owner: string | null, repository: string) =>
	manifests.find((manifest) => manifest.owner === owner && manifest.repository === repository);

/** Every owner's home repository is named `home`; yours is `me/home`, made when first used. */
export const HOME = 'home';

/** Whether `manifest` is your home. */
export const isHome = (manifest: Pick<Manifest, 'owner' | 'repository'>) => manifest.owner === null && manifest.repository === HOME;

/** A repository id for a new repository of yours kept only here: its name as a name (`NAME`), made unique among yours. */
function localIdFor(name: string, manifests: readonly Manifest[]) {
	const slug = name
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^[^a-z]+|-+$/g, '');
	const base = slug === '' ? 'repository' : slug;
	let id = base;
	for (let n = 2; findAt(manifests, null, id) !== undefined; n++) id = `${base}-${n}`;
	return id;
}

/**
 * Make a copy in this browser and let it go once its worker has written its
 * manifest, so the repository's page opens the one handle it keeps.
 */
async function make(options: { owner: string | null; repository: string; name: string; account: string | null; url: string | null }): Promise<Result<Manifest, BrowserReplicaError>> {
	const created = await createBrowserRepository({ app: lens, ...options, headers: headersOf(options) });
	if (created.error !== null) return created;
	const { repository, manifest } = created.data;
	/** Null once it opens, or why it could not. */
	const reached = await new Promise<string | null>((resolve) => {
		const settled = () => {
			const now = repository.status();
			if (now.status === 'open') resolve(null);
			else if (now.status === 'unavailable') resolve(now.reason);
			else return false;
			return true;
		};
		if (settled()) return;
		const stop = repository.subscribe(() => {
			if (settled()) stop();
		});
	});
	repository.close();
	await repositories.refresh();
	return reached === null ? Ok(manifest) : BrowserReplicaError.Unavailable({ reason: reached });
}

/** A new repository of yours, kept only on this device. */
export async function createLocal(name: string) {
	const manifests = listed ?? (await repositories.refresh());
	return make({ owner: null, repository: localIdFor(name, manifests), name, account: null, url: null });
}

/** This device's copy of `owner`'s `repository` on the server at `url`, syncing as `account`; refused unless both are names (`NAME`). */
export async function join({ owner, repository, url, account }: { owner: string | null; repository: string; url: string; account: string }) {
	for (const [what, value] of [
		['owner', owner],
		['repository', repository],
	] as const)
		if (value !== null && !NAME.test(value))
			return BrowserReplicaError.Unavailable({ reason: `the ${what} '${value}' is not a name: a letter, then lowercase letters, digits and -` });
	return make({ owner, repository, name: repository, account, url });
}

/** Your home, `me/home`, kept on this device until accounts keep it. */
export const createHome = () => make({ owner: null, repository: HOME, name: 'Home', account: null, url: null });

/** Delete a copy from this browser; refused, with what it would lose, while it has files only here, unless `discardUnsent`. */
export async function remove(manifest: Manifest, discardUnsent: boolean) {
	const removed = await removeBrowserRepository({ replica: manifest.replica, discardUnsent });
	await repositories.refresh();
	return removed;
}
