/**
 * Registering the engine as a Chrome native messaging host (spike).
 *
 * A browser finds a host by a JSON manifest named `<name>.json` in its
 * `NativeMessagingHosts` directory, which is the `NativeMessagingHosts`
 * subdirectory of the browser's user data directory on macOS and Linux and
 * a registry key on Windows. The manifest's `path` is an executable and
 * nothing more: Chrome runs it with the caller's origin as its only argument,
 * so the engine, which needs `native-host` first, is reached through a
 * wrapper script beside it.
 *
 * ```txt
 * ~/.epicenter/bin/epicenter                      link to the app's bundled CLI
 * ~/.epicenter/bin/epicenter-native-host          wrapper: exec epicenter native-host "$@"
 * ~/Library/Application Support/<browser>/NativeMessagingHosts/so.epicenter.engine.json
 * ```
 *
 * See https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
 * and https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { NATIVE_HOST_NAME } from './native-host.ts';
import { shellQuote } from './sync/git.ts';

export type NativeHostManifest = {
	readonly name: string;
	readonly description: string;
	readonly path: string;
	readonly type: 'stdio';
	readonly allowed_origins: readonly string[];
};

const EXTENSION_ID = /^[a-p]{32}$/;

/** The manifest for the wrapper at `path`, open to each extension id. */
export function nativeHostManifest(
	path: string,
	extensionIds: readonly string[],
): NativeHostManifest {
	for (const id of extensionIds)
		if (!EXTENSION_ID.test(id))
			throw new Error(`'${id}' is not an extension id.`);
	return {
		name: NATIVE_HOST_NAME,
		description: 'Epicenter: save to and read from your Epicenter folders.',
		path,
		type: 'stdio',
		// No wildcards: each origin is one extension, with its trailing slash.
		allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
	};
}

/**
 * The wrapper Chrome runs: the engine at `engine` as `native-host`, in the
 * environment the engine was linked for, since Chrome passes neither.
 */
export function nativeHostWrapper({
	engine,
	environment,
	desktopGrant = false,
}: {
	engine: string;
	environment: 'production' | 'development';
	desktopGrant?: boolean;
}): string {
	return [
		'#!/bin/sh',
		'# Chrome runs this native messaging host with the caller origin as $1.',
		`EPICENTER_ENVIRONMENT=${environment} exec ${shellQuote(engine)} native-host${desktopGrant ? ' --desktop' : ''} "$@"`,
		'',
	].join('\n');
}

/**
 * Each Chromium browser's per-user manifest directory on macOS: the
 * `NativeMessagingHosts` subdirectory of its default user data directory.
 * Linux reads `~/.config/<browser>/NativeMessagingHosts`; Windows reads a
 * registry key whose default value is the manifest's path. Neither is
 * written here.
 */
export function macManifestDirectories(home: string): Record<string, string> {
	const support = join(home, 'Library', 'Application Support');
	return {
		chrome: join(support, 'Google', 'Chrome', 'NativeMessagingHosts'),
		chromeForTesting: join(
			support,
			'Google',
			'ChromeForTesting',
			'NativeMessagingHosts',
		),
		chromium: join(support, 'Chromium', 'NativeMessagingHosts'),
		brave: join(
			support,
			'BraveSoftware',
			'Brave-Browser',
			'NativeMessagingHosts',
		),
		edge: join(support, 'Microsoft Edge', 'NativeMessagingHosts'),
	};
}

/**
 * Write the wrapper beside `engine` and one manifest into each directory in
 * `manifestDirectories`. Returns the paths written.
 */
export async function installNativeHost({
	engine,
	environment,
	extensionIds,
	manifestDirectories,
	desktopGrant,
}: {
	engine: string;
	environment: 'production' | 'development';
	extensionIds: readonly string[];
	manifestDirectories: readonly string[];
	desktopGrant?: boolean;
}): Promise<{ wrapper: string; manifests: string[] }> {
	const wrapper = join(dirname(engine), 'epicenter-native-host');
	await mkdir(dirname(wrapper), { recursive: true });
	await writeFile(
		wrapper,
		nativeHostWrapper({ engine, environment, desktopGrant }),
	);
	await chmod(wrapper, 0o755);
	const text = `${JSON.stringify(nativeHostManifest(wrapper, extensionIds), null, '\t')}\n`;
	const manifests: string[] = [];
	for (const directory of manifestDirectories) {
		await mkdir(directory, { recursive: true });
		const manifest = join(directory, `${NATIVE_HOST_NAME}.json`);
		await writeFile(manifest, text);
		manifests.push(manifest);
	}
	return { wrapper, manifests };
}
