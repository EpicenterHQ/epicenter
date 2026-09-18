import type { Account } from '@epicenter/auth';
import { createDefaultAppAi } from '#platform/ai';
import { resources } from '#platform/resources';
import { type App, composeApp } from './compose.js';
import type { DataDefinition } from './data/definition/declaration.js';

/** Open one application lifetime using this build's storage, capture, and inference implementations. */
export function openApp<const TDefinition extends DataDefinition>(
	definition: TDefinition,
): App<TDefinition, undefined>;
export function openApp<
	const TDefinition extends DataDefinition,
	TAccount extends Account | undefined,
>(definition: TDefinition, account: TAccount): App<TDefinition, TAccount>;
export function openApp<const TDefinition extends DataDefinition>(
	definition: TDefinition,
	account?: Account,
) {
	return composeApp(definition, {
		...resources,
		appId: definition.id,
		account,
		ai: createDefaultAppAi(),
	});
}

export type { App, AppStore } from './compose.js';
export type AppSqlite = App<DataDefinition>['device']['sqlite'];
export type AppBlobs = App<DataDefinition>['blobs'];
