/**
 * The Folders window's own state, made once when the page loads: the home
 * (`listHome`: every folder with its title, state, and members, the
 * question each folder not synced here asks, the shares waiting, and the
 * folders held elsewhere) and the background sync (`keepEverySynced`),
 * which runs while the app does, with or without the window shown
 * (ADR-0819), and syncs a folder an app made as if the person had chosen
 * to (ADR-0822). Both are `@epicenter/folder/platform`'s, as is a Git
 * import (`importGit`, over the shell's Git); this module only keeps the
 * signed-in account they run as, and says what each action did.
 *
 * The sync starts once the settings connected and someone is signed in, and
 * starts again for another account. The home is read again when the
 * account changes, after an action, when the window is shown, and every
 * half minute while it is, since the marks, not the home, follow each round.
 */
import type { Account } from '@epicenter/account';
import type { FolderRole } from '@epicenter/definition/site';
import {
	type Answer,
	acceptIntoHome,
	attachFolder,
	cloneIntoHome,
	firstPartyApps,
	type Home,
	type HomeFolder,
	importGit,
	initFolder,
	type KeptFolders,
	type KeptState,
	keepEverySynced,
	listHome,
	shareFolder,
	syncFolder,
	unshareFolder,
} from '@epicenter/folder/platform';
import { settings } from '@epicenter/local';
import { toast } from '@epicenter/ui/sonner';
import { auth, root } from './app';
import { shellGit } from './git-host';

/** How often the home is read again while the window is shown. */
const HOME_EVERY_MS = 30_000;

/** The apps a folder can be made by, which the sync syncs as the person would. */
const apps = firstPartyApps();

/** What an action answers: its error's message, if it failed. */
type Done = { error: { message: string } | null };

function createHome() {
	let account = $state.raw<Account | null>(null);
	let home = $state.raw<Home | null>(null);
	let homeError = $state<string | null>(null);
	let reading = $state(false);
	let kept: KeptFolders | null = null;
	let keptState = $state.raw<KeptState | null>(null);
	let stopKept = () => {};
	/** The signed-in person's email, for declining a share. */
	let email: string | null = null;

	async function read() {
		reading = true;
		const asked = account;
		let listed = await listHome({ root, account: asked ?? undefined, apps });
		// Out of reach or refused: what this computer holds, and why.
		if (listed.error !== null && asked !== null) {
			homeError = listed.error.message;
			listed = await listHome({ root, apps });
		} else homeError = listed.error?.message ?? null;
		if (asked === account && listed.error === null) home = listed.data;
		reading = false;
	}

	let followed = false;

	/** Run the sync as `next`, the signed-in account, or stop it for none. */
	function follow(next: Account | null) {
		// The first answer is read whoever it names, a signed-out one included.
		if (followed && next === account) return;
		followed = true;
		stopKept();
		kept?.[Symbol.dispose]();
		kept = null;
		keptState = null;
		email = null;
		account = next;
		if (next !== null) {
			const started = keepEverySynced({ account: next, root, apps });
			kept = started;
			keptState = started.state();
			stopKept = started.subscribe(() => {
				keptState = started.state();
			});
		}
		void read();
	}

	// Who is signed in is read once the settings connected; one that failed
	// to connect is tried again, since nothing else would.
	let following = false;
	const connected = () => {
		const state = settings.state();
		if (state.status === 'failed') {
			homeError = state.error.message;
			setTimeout(() => void state.retry(), 5000);
		}
		if (state.status !== 'open' || following) return;
		following = true;
		const now = () => {
			const signIn = auth.state();
			follow(signIn.status === 'signed-in' ? signIn.account : null);
		};
		auth.subscribe(now);
		now();
	};
	settings.subscribe(connected);
	connected();

	// While the window is shown, the home is read again on focus and every
	// half minute.
	let timer: ReturnType<typeof setInterval> | undefined;
	const shown = () => {
		clearInterval(timer);
		if (document.visibilityState !== 'visible') return;
		void read();
		timer = setInterval(() => void read(), HOME_EVERY_MS);
	};
	document.addEventListener('visibilitychange', shown);
	window.addEventListener('focus', () => void read());

	/** Say how `done` ended, then read the home again. */
	async function after(done: Promise<Done>, success: string) {
		const { error } = await done;
		if (error !== null) toast.error(error.message);
		else toast.success(success);
		await read();
		return error === null;
	}

	/** The account an action needs, or a refusal to show. */
	function signedIn() {
		if (account === null) toast.error('Sign in to sync and share folders.');
		return account;
	}

	return {
		/** The signed-in account the sync runs as; null signed out. */
		account: () => account,
		home: () => home,
		/** Why the server was not asked, or the folder not read, when it was not. */
		homeError: () => homeError,
		reading: () => reading,
		/** The sync's marks, whether a round runs, and how the last ended. */
		sync: () => keptState,
		refresh: read,

		/** Sync every folder now. */
		async syncNow() {
			if (kept === null) return void signedIn();
			const every = await kept.now();
			if (every === null && keptState?.last?.error)
				toast.error(keptState.last.error);
			await read();
		},

		/**
		 * Sync a folder not synced here, as the person chose: with `answer`
		 * (a folder they hold, or a new one), or, without one, as a new folder
		 * when nothing matches and with its one match they hold alone.
		 */
		async syncFirst(folder: HomeFolder, answer?: Answer) {
			const as = signedIn();
			if (as === null) return;
			const done = syncFolder({
				account: as,
				root,
				name: folder.name,
				answer,
				apps,
			}).then((result) =>
				result.error === null && result.data.kind === 'question'
					? { error: { message: `Choose which folder ${folder.name} is.` } }
					: result,
			);
			await after(done, `${folder.title ?? folder.name} syncs now.`);
		},

		/**
		 * The person's answer to a folder stopped because its sync would
		 * delete many files on the server: delete them there, or bring them
		 * back here.
		 */
		async answerDeletions(folder: HomeFolder, deletions: 'push' | 'restore') {
			if (kept === null) return void signedIn();
			await kept.answer(folder.path, deletions);
			toast.success(
				deletions === 'push'
					? `The files deleted in ${folder.title ?? folder.name} are deleted on the server too.`
					: `The files deleted in ${folder.title ?? folder.name} are back.`,
			);
			await read();
		},

		/** Add a contract to a folder, titled by its name. */
		async init(folder: HomeFolder) {
			const local = (await root.list()).data?.folders.find(
				({ path }) => path === folder.path,
			);
			if (local === undefined) return;
			await after(
				initFolder({
					store: local.store,
					title: folder.name,
					path: folder.path,
				}),
				`${folder.name} has an epicenter.json now.`,
			);
		},

		/** Bring a folder the person holds onto this computer. */
		async clone(id: string, title: string | null) {
			const as = signedIn();
			if (as === null) return;
			await after(
				cloneIntoHome({ account: as, root, folder: id }),
				`${title ?? 'The folder'} is in your Epicenter folder.`,
			);
		},

		/** Accept a share and bring it beside the person's own folders. */
		async accept(id: string, title: string | null) {
			const as = signedIn();
			if (as === null) return;
			await after(
				acceptIntoHome({ account: as, root, folder: id }),
				`${title ?? 'The folder'} is yours now.`,
			);
		},

		/** Decline a share waiting for the person. */
		async decline(id: string) {
			const as = signedIn();
			if (as === null) return;
			if (email === null) {
				const profile = await as.getProfile();
				email = profile.data?.email ?? null;
			}
			if (email === null)
				return void toast.error('Who is signed in could not be read.');
			await after(
				unshareFolder(as, { folder: id, email }),
				'The share is declined.',
			);
		},

		/** Share a folder with the person who signs in as `email`, or change their role. */
		share(id: string, person: string, role: FolderRole) {
			const as = signedIn();
			if (as === null) return Promise.resolve(false);
			return after(
				shareFolder(as, { folder: id, email: person, role }),
				`${person} is invited as a ${role}.`,
			);
		},

		/** Take a person out of a folder, or cancel their invitation. */
		unshare(id: string, person: string) {
			const as = signedIn();
			if (as === null) return Promise.resolve(false);
			return after(
				unshareFolder(as, { folder: id, email: person }),
				`${person} no longer has this folder.`,
			);
		},

		/**
		 * Make a folder of the Git repository at `source` (a path on this
		 * computer, or a URL), through the shell's Git, and say what was left
		 * out. With `replaceOriginal`, the repository moves aside and a link
		 * at its path points to the new folder.
		 */
		async importFromGit(source: string, replaceOriginal: boolean) {
			const as = signedIn();
			if (as === null) return false;
			const made = await importGit({
				host: shellGit,
				source: source.trim(),
				replaceOriginal,
				account: as,
				root,
			});
			if (made.error !== null) {
				toast.error(made.error.message);
				return false;
			}
			const { path, changes, warnings, original } = made.data;
			toast.success(`${path} holds ${changes} changes from Git.`, {
				description:
					[
						...(original === null
							? []
							: [
									`The original is at ${original.movedTo}, and ${original.link} links to the new folder.`,
								]),
						...warnings,
					].join('\n') || undefined,
			});
			await read();
			return true;
		},

		/** Attach a folder to an app, so the app reaches it, or detach it. */
		attach(id: string, app: string, attached: boolean) {
			const as = signedIn();
			if (as === null) return Promise.resolve(false);
			return after(
				attachFolder(as, { folder: id, app, attached }),
				attached
					? `${app} reaches this folder now.`
					: `${app} no longer reaches this folder.`,
			);
		},
	};
}

export const folders = createHome();
