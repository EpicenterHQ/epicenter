/**
 * A desktop app's own configuration (decision 82): one Markdown note,
 * `settings.md`, in the operating system's configuration directory for the
 * app. It is machine-local and never synced. `folder` is where the app keeps
 * the person's files, chosen on first run and with "Choose folder…"; other
 * machine settings go beside it as more fields. API keys never go here: they
 * stay in the keychain.
 *
 * The desktop shell reads and writes the same note in Rust
 * (`epicenter-standalone`'s `Places`), before the page exists.
 */
import { defineContract } from '@epicenter/definition/contract';

export const appConfig = defineContract({
	name: 'app-config',
	description:
		"A desktop app's machine-local settings, never synced: `folder` is where it keeps the person's files.",
	collections: {
		settings: {
			path: 'settings.md',
			fields: { folder: { type: 'string' } },
		},
	},
});

export type AppConfig = typeof appConfig;
