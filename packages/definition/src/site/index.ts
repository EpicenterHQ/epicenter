/**
 * `@epicenter/definition/site`: the names an app's site derives. The app
 * registry (origins, dev ports, OAuth audiences), the folder, repository and
 * data identifier an app takes from its production site (ADR-0722), and the
 * repository name grammar. Every module here is pure and runs in a page, a
 * Worker and Bun alike; the OS data root, which reads `node:os`, is
 * `@epicenter/definition/site/app-data`.
 *
 * Vite loads an app's `vite.config.ts` in Node, which imports `APPS` from
 * here without a bundler. Node resolves only real file names and strips only
 * erasable TypeScript, so these imports name `.ts` files and the modules use
 * no TypeScript-only runtime syntax.
 */
export {
	type AppEnvironment,
	AppNameError,
	type AppNameErrorKind,
	appDataIdentifier,
	hostFromIdentifier,
	hostFromSiteUrl,
	isPersonalFolderName,
	relativeFolderPath,
	repositoryName,
	suggestLibraryLinkName,
} from './app-names.ts';
export {
	API_BUN_DEV_PORT,
	APPS,
	type AppKey,
	EPICENTER_API_URL,
	localUrl,
	PRODUCTION_API_URL,
	resolveOAuthAudiences,
} from './apps.ts';
export {
	type GrantLevel,
	folderUrl,
	isFolderId,
	isNamespaceId,
	isRepositoryName,
	type ListedNamespace,
	type ListedRepository,
	MAX_REPOSITORY_NAME_LENGTH,
	parseRepositoryPath,
	parseRepositoryUrl,
	type RepositoryGrant,
	type RepositoryGrantRevoked,
	type RepositoryGrants,
	type RepositoryListing,
	type RepositoryPath,
	repositoryGrantsUrl,
	repositoryUrl,
	toRepositoryName,
} from './repositories.ts';
