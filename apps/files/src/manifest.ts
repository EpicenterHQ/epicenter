/**
 * Files as an app (ADR-0694): served at `files.epicenter.so`, with no
 * collections of its own. It reads and writes every file through the plain
 * file API (`repo.files`), so it shows any repository, and any link whose
 * app is not installed falls back to it.
 */
import { defineManifest } from '@epicenter/app';
import { defineApp } from '@epicenter/repository';

export const manifest = defineManifest({
	name: 'Files',
	hostname: 'files.epicenter.so',
	collections: defineApp({}),
});
