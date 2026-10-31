/**
 * Honeycrisp's contract: a note is a Markdown note at `notes/{id}.md`, a
 * folder one at `folders/{id}.md`. A note's title, the folder it is in,
 * whether it is pinned, and when it was made are front matter; its text is
 * the body. A folder is its name (and an optional emoji icon).
 *
 * A note names its folder by id (`folderId`), so moving a note between
 * folders changes one key and never moves its file. A `folderId` that names
 * no folder (the folder was deleted, or has not arrived yet) is still the
 * note's; the note shows in All Notes. A note with no `folderId` is in no
 * folder. A note with no `title` shows its first line instead.
 *
 * Honeycrisp has no settings, so it has no settings note, and keeps no
 * other files. Its name makes the repository `<account>/honeycrisp`
 * (decision 46). It is published, unchanged, as `static/contract.json`
 * (`bun run contract` writes it), so `epicenter check <url>/contract.json
 * <dir>` checks a clone.
 */
import { APPS } from '@epicenter/constants/apps';
import { defineContract } from '@epicenter/definition/contract';

export const honeycrisp = defineContract({
	name: 'honeycrisp',
	description:
		'Markdown notes: a note per file, its title, folder, pin and creation time in front matter, its text in the body; folders are notes of their own that notes name by id.',
	collections: {
		notes: {
			path: 'notes/{id}.md',
			fields: {
				title: { type: 'string' },
				folderId: { type: 'string' },
				pinned: { type: 'boolean' },
				createdAt: { type: 'string', format: 'date-time' },
			},
			required: ['createdAt'],
		},
		folders: {
			path: 'folders/{id}.md',
			fields: {
				name: { type: 'string' },
				icon: { type: 'string' },
			},
			required: ['name'],
		},
	},
});

export type Honeycrisp = typeof honeycrisp;

/** Where the contract is published, which the desktop app names when it asks Epicenter to sync its folder. */
export const CONTRACT_URL = `${APPS.HONEYCRISP.url}/contract.json`;
