/**
 * The page's side of Honeycrisp's own shell commands: close consent, the
 * terminal, per-file history, and reveal. The folder itself comes from
 * `@epicenter/folder/tauri`; nothing here reads or writes a note.
 *
 * Close consent has an order the page must keep:
 *
 * 1. Register before opening the folder. Until the page says its folder is
 *    open, the shell lets a close go ahead, because no edit exists yet.
 * 2. Listen for close requests before saying the folder is open, so the
 *    first request cannot arrive unheard.
 * 3. Say the folder is open before the notes exist. From then on every close
 *    is asked, and only an answer naming this page and that request lets it
 *    go ahead.
 * 4. Stop taking input before waiting for writes to land, and keep it
 *    stopped until the approval is known to be refused.
 *
 * `openGuarded` keeps that order. A page that cannot register or cannot say
 * its folder is open shows no notes.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ClosableNotes, FileRevision, NotesHost } from './types.js';

/** The event the shell sends when it held back a close or quit. */
const CLOSE_REQUESTED = 'close-requested';

type CloseAsk = { readonly generation: number; readonly request: number };

/**
 * The gate's two answers that mean an approval was not taken and the app is
 * not closing: this page was replaced, or the request was already answered.
 * They are the texts of `Refusal::StalePage` and `Refusal::NoSuchRequest` in
 * `src-tauri/src/close.rs`, which `close_approve` rejects with. The gate's
 * third refusal, "the app is already closing", is deliberately not here.
 */
const APPROVAL_NOT_TAKEN: ReadonlySet<unknown> = new Set([
	'this page was replaced by a newer one',
	'this close request is no longer waiting for an answer',
]);

/** One held close. Either answer is final; a second answer does nothing. */
export type CloseRequest = {
	/** Every write and action has landed; the app may close. */
	approve(): Promise<void>;
	/** Keep the app open. The page itself never declines; the gate still takes it. */
	decline(): Promise<void>;
};

export type PageClose = {
	/**
	 * The folder is open: answer every close from now on. Rejects when the
	 * shell is already closing, and then no notes may be shown.
	 */
	hold(answer: (request: CloseRequest) => Promise<void>): Promise<void>;
	/** Stop listening. Only for a page that never held. */
	dispose(): void;
};

/**
 * Register this page with the shell and listen for close requests.
 * `report` receives an answer that failed; the close stays held.
 */
export async function registerPage(
	report: (cause: unknown) => void,
): Promise<PageClose> {
	const generation = await invoke<number>('close_register');
	let answer: ((request: CloseRequest) => Promise<void>) | undefined;
	/** The request being answered. The shell repeats it until it is answered. */
	let answering: number | undefined;

	const unlisten = await listen<CloseAsk>(CLOSE_REQUESTED, ({ payload }) => {
		// A request for an earlier page of this window is not this page's to answer.
		if (payload.generation !== generation || answer === undefined) return;
		const { request } = payload;
		if (answering === request) return;
		answering = request;
		let answered = false;
		const reply = (command: 'close_approve' | 'close_decline') => async () => {
			if (answered) return;
			answered = true;
			await invoke<void>(command, { generation, request });
		};
		answer({ approve: reply('close_approve'), decline: reply('close_decline') })
			.catch(report)
			.finally(() => {
				if (answering === request) answering = undefined;
			});
	});

	return {
		async hold(next) {
			answer = next;
			try {
				await invoke<void>('close_opened', { generation });
			} catch (cause) {
				answer = undefined;
				throw cause;
			}
		},
		dispose: unlisten,
	};
}

/**
 * Answer one held close: let every write and action land, then approve.
 * Nothing is ever discarded, so the page never asks the person.
 *
 * Input is fenced before anything is waited for, so nothing typed afterward
 * can start a write the close would not wait for, and it stays fenced while
 * the approval is on its way: the shell exits when it takes it. The fence is
 * released only when the gate says this approval was not taken and the app is
 * not closing (`APPROVAL_NOT_TAKEN`). Every other failure, including any other
 * text, keeps the fence: it does not say whether the shell took the approval,
 * and "already closing" says it is exiting. The next close is asked again.
 */
async function answerClose(
	notes: ClosableNotes | undefined,
	request: CloseRequest,
): Promise<void> {
	const release = notes?.fenceInput() ?? (() => {});
	try {
		await notes?.settle();
	} catch (cause) {
		release();
		throw cause;
	}
	try {
		await request.approve();
	} catch (cause) {
		if (APPROVAL_NOT_TAKEN.has(cause)) release();
		throw cause;
	}
}

/**
 * Open a page's notes with close consent in place before they exist.
 *
 * A failure to register or to open the folder leaves the shell free to close:
 * there are no notes. Once the folder is held, a close is always answered,
 * even when creating the notes failed afterward.
 */
export async function openGuarded<
	THost extends { close(): Promise<void> },
	TNotes extends ClosableNotes,
>({
	acquire,
	create,
	report,
}: {
	/** Open the folder. Nothing a person can edit exists yet. */
	acquire(): Promise<THost>;
	/** Create the notes state over the opened folder. */
	create(host: THost): Promise<TNotes>;
	report(cause: unknown): void;
}): Promise<TNotes> {
	const page = await registerPage(report);
	let host: THost;
	try {
		host = await acquire();
	} catch (cause) {
		page.dispose();
		throw cause;
	}
	let notes: TNotes | undefined;
	try {
		await page.hold((request) => answerClose(notes, request));
	} catch (cause) {
		page.dispose();
		await host.close();
		throw cause;
	}
	// From here the listener stays: a close is asked whatever happens next,
	// and with no notes there is nothing to save, so it is approved.
	try {
		notes = await create(host);
	} catch (cause) {
		await host.close();
		throw cause;
	}
	return notes;
}

type ShellInfo = {
	/** The absolute notes directory. */
	readonly root: string;
	/** Where the next terminal command starts, absolute. */
	readonly cwd: string;
};

type TerminalReply = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly cwd: string;
};

/**
 * The parts of a `NotesHost` the shell's own commands provide. The shell
 * holds the root and the terminal's working directory; this sends neither.
 */
export async function openShellServices(): Promise<
	Pick<NotesHost, 'terminal' | 'location' | 'reveal' | 'history'>
> {
	const info = await invoke<ShellInfo>('shell_info');
	let cwd = info.cwd;
	const shown = (path: string) =>
		path === info.root
			? '/'
			: path.startsWith(`${info.root}/`)
				? path.slice(info.root.length)
				: path;
	return {
		terminal: {
			get cwd() {
				return shown(cwd);
			},
			description: `/bin/sh in ${info.root} · the same files, real git`,
			async exec(command) {
				const reply = await invoke<TerminalReply>('terminal_run', { command });
				cwd = reply.cwd;
				return reply;
			},
		},
		location: info.root,
		// A refused command rejects with the shell's own words, as text.
		reveal: () =>
			invoke<void>('reveal_folder').then(
				() => undefined,
				(cause) => String(cause),
			),
		history: {
			log: (path, depth) => invoke<FileRevision[]>('file_log', { path, depth }),
			show: (oid, path) => invoke<string>('file_show', { oid, path }),
		},
	};
}
