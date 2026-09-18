import type { Account } from '@epicenter/auth';
import { type App, composeApp } from './compose.js';
import type { DataDefinition } from './data/definition/declaration.js';
import { defaultRuntime } from './platform/default.js';
import type { AppRuntime } from './runtime.js';

/** Open one App lifetime with a complete runtime, defaulting to the current platform. */
export function openApp<const TDefinition extends DataDefinition>(
	definition: TDefinition,
	options?: { account?: undefined; runtime?: AppRuntime },
): App<TDefinition, undefined>;
export function openApp<
	const TDefinition extends DataDefinition,
	TAccount extends Account | undefined,
>(
	definition: TDefinition,
	options: { account: TAccount; runtime?: AppRuntime },
): App<TDefinition, TAccount>;
export function openApp<const TDefinition extends DataDefinition>(
	definition: TDefinition,
	options: { account?: Account; runtime?: AppRuntime },
): App<TDefinition, Account | undefined>;
export function openApp<const TDefinition extends DataDefinition>(
	definition: TDefinition,
	options: { account?: Account; runtime?: AppRuntime } = {},
) {
	if (
		options === null ||
		typeof options !== 'object' ||
		Reflect.ownKeys(options).some(
			(key) => key !== 'account' && key !== 'runtime',
		)
	)
		throw new TypeError('openApp expects { account?, runtime? } options.');
	return composeApp(definition, {
		...(options.runtime ?? defaultRuntime()),
		appId: definition.id,
		account: options.account,
	});
}

export type { App, AppStore } from './compose.js';
export type { AppRuntime } from './runtime.js';
export type AppSqlite = App<DataDefinition>['device']['sqlite'];
export type AppBlobs = App<DataDefinition>['blobs'];
