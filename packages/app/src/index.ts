/**
 * One application's Epicenter Data session: the replica it opens, and the
 * account it opens it for (ADR-0316, ADR-0339).
 *
 * An application creates `epicenter` once and opens a session for its selected account. It
 * never selects IndexedDB, a generation number, or a socket, because none of
 * those names appear on this surface.
 *
 * **This handle is the session and nothing else.** Device-owned SQLite files
 * and secrets are `@epicenter/device`, a separate package because they are
 * a separate kind of thing: a file is a device cache opened before anyone signs
 * in and a keychain entry is how an account is reached at all, so neither has a
 * principal to be scoped by. Keeping them here made this package vary by
 * runtime and carry a SQLite worker for three applications that never called
 * one.
 *
 * The store is client-owned in every runtime (ADR-0226, ADR-0227), so there is
 * one `createEpicenter` and it serves every build. Nothing about a session
 * varies by platform, which is why there is no seam under it and no
 * `typeof window` test: a desktop build runs in a WebView, so a runtime sniff
 * could not tell it apart from a browser tab anyway.
 */

import type { Account } from '@epicenter/auth';
import { isAppId } from '@epicenter/constants/app-id';
import type { ReplicaData } from '@epicenter/data';
import type { OpenedDatabase, StoreError } from '@epicenter/data/browser';
import type {
	DataDefinition,
	DataDefinitionParseError,
} from '@epicenter/data/definition';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { eraseReplicaOf, openReplica } from './client-owned-data.js';

/**
 * What can end an open without the store having refused anything.
 *
 * Two variants, and neither is the store's business. A close that lands while
 * an open is in flight ends what that open acquired, and the caller awaiting it
 * has to be told: answering `Ok` with a store whose every verb throws is a
 * success over a dead document, and `openWhisperingApp` reads exactly that
 * channel. An opener that REJECTS is the other: `openReplica` contains its own
 * throws, and a promise that breaks that contract must not leave a session
 * wedged in `opening` with no way back.
 */
export const DataSessionError = defineErrors({
	SessionClosed: () => ({
		message: 'This data session was closed while it was opening.',
	}),
	OpenerThrew: ({ cause }: { cause: unknown }) => ({
		message: 'Opening this data session threw instead of resolving.',
		cause,
	}),
});
export type DataSessionError = InferErrors<typeof DataSessionError>;

/** This application's one data definition. Account selection happens at open. */
export type EpicenterDataOptions<TDefinition extends DataDefinition> = {
	/**
	 * This application's one data definition, which an application has exactly
	 * one of and imports (ADR-0313).
	 */
	definition: TDefinition;
};

export type CreateEpicenterOptions = {
	/**
	 * The opening application, which is one segment of the store address.
	 *
	 * State it explicitly even when it matches `definition.id`: the opening
	 * application is an independent part of a store address (ADR-0324), and
	 * making it explicit keeps the constructor honest about the scope it is
	 * opening. It scopes the replica and nothing else; device-owned files and
	 * secrets are `@epicenter/device`, which knows no person.
	 */
	appId: string;
};

/**
 * What a store can fail to open with: the store's own refusals, and a
 * declaration this release cannot read.
 *
 * Named because four surfaces state it and three of them were writing the
 * union out. It is deliberately not narrowed to "the ones a person sees": a
 * boot node switches on `name` and falls through, so a new refusal reaching an
 * application is a sentence to write rather than a type to widen.
 *
 * `DataSessionError` is in it because an open can end for a reason that is
 * about the session rather than about the store: closed underneath, or an
 * opener that rejected. Neither reaches `state`, which reports `closed` for the
 * first and `failed` for the second, but both reach whoever awaited `open`.
 */
export type DataOpenError =
	| StoreError
	| DataDefinitionParseError
	| DataSessionError;

/**
 * One open of one replica, and the two things that end it.
 *
 * A value the caller owns, not a state the handle publishes. `open(account)` hands one
 * back synchronously and every state a surface used to switch on is a branch of
 * `opened`: pending is `{#await}`, refused is its `error`, ready is its `data`.
 * There is no `closed` state, because a caller holding this is holding the
 * session that has it.
 *
 * **A session answers for the principal that created it.** `open(account)` captures the
 * account at the call, so a client that signs in as somebody else while
 * this was opening does not move the address this opened.
 */
export type DataSession<TDefinition extends DataDefinition> = {
	/**
	 * What this open answered, settled once.
	 *
	 * It resolves a `Result` and never rejects. `close()` ends what the open
	 * acquired; it does not retract what the open answered, so a surface still
	 * rendering the resolved branch is not told a different story on its way
	 * out.
	 */
	readonly opened: Promise<Result<ReplicaData<TDefinition>, DataOpenError>>;
	/**
	 * Release the lock, the socket, and the page-hide listener together
	 * (ADR-0340).
	 *
	 * Idempotent, and a no-op once the handle has superseded this session: the
	 * tree creates a keyed child before it destroys the one it replaces, so the
	 * old child's cleanup lands after the new child has already opened. It
	 * resolves when the address is free, which is what lets a caller await a
	 * close and then open without meeting its own lock.
	 */
	close(): Promise<void>;
	/**
	 * Close this session and erase the copy it was opened for.
	 *
	 * Every generation this account holds through this application, because a
	 * person forgetting their copy means all of it: erasing only the newest
	 * would leave the number below it to be opened next boot. Oldest first, so
	 * an interruption leaves the newest rather than a number nobody chose.
	 *
	 * `afterClose` runs between the release and the first delete, and it exists
	 * for one caller: the destructive exit, which clears the credential there.
	 * That order is what makes an interrupted removal safe on a shared device,
	 * and it has to be here because only the session knows when the close is
	 * done.
	 *
	 * It THROWS to abort, and that throw leaves this verb, which is the one way
	 * this promise rejects. Nothing is deleted by a step that did not finish, and
	 * the surface that invoked the exit already catches: it has to, because the
	 * close unmounted whatever rendered the button.
	 *
	 * **A failure does not reopen.** Closing is what the deletion needs rather
	 * than the deletion itself, so a refused erase leaves the copy on the device
	 * and leaves the handle holding nothing. Reopening is the caller's move, and
	 * it is the same call a retry makes.
	 */
	erase(options?: {
		afterClose?: () => Promise<void>;
	}): Promise<Result<void, StoreError>>;
};

/**
 * One application's definition and the queue that serializes its data sessions.
 *
 * **Construction is inert and opening is a verb.** `createEpicenter` claims no
 * Web Lock, touches no IndexedDB, and makes no round trip; `open` does all
 * three plus dialling sync and attaching the flush-on-hide listener.
 *
 * **The handle serializes sessions, because the tree cannot.** Svelte creates
 * the branch for a new key before it destroys the old one, so a keyed child
 * that opens at init runs before its predecessor's cleanup closes. Every
 * acquire and release the handle performs against its one address goes through
 * one queue, which is what makes tree order irrelevant.
 */
export type Epicenter<TDefinition extends DataDefinition> = {
	readonly appId: string;
	/**
	 * Open this application's store as a replica of the account, syncing.
	 *
	 * Synchronous, and it supersedes whatever session the handle was holding:
	 * that one is closed first, and this one's open runs after the release, so
	 * it meets a free address rather than its own lock.
	 */
	open(account: Account): DataSession<TDefinition>;
	/**
	 * Close whichever session the handle is holding.
	 *
	 * An application does not call this; a component closes the session it owns.
	 * The caller this exists for is a hot reload, which replaces the module that
	 * built the handle and has to release its claim before the replacement
	 * opens, with no reference to the session in hand. A handle holding nothing
	 * closes without complaint.
	 */
	close(): Promise<void>;
};

/** Create one handle that opens one application's replica of one account. */
export function createEpicenter<const TDefinition extends DataDefinition>({
	appId,
	definition,
}: CreateEpicenterOptions &
	EpicenterDataOptions<TDefinition>): Epicenter<TDefinition> {
	if (!isAppId(appId)) {
		throw new Error(`The application id '${appId}' is not valid.`);
	}

	/**
	 * What the handle knows: which session owns the address, and the order
	 * everything it does to that address happens in.
	 *
	 * `live` is the session the handle is holding, or nothing. `queue` is the
	 * chain every acquire and release joins, so a release always finishes before
	 * the next acquire starts. It never rejects: a step that throws is a step
	 * whose own session already heard about it.
	 */
	let live: SessionRecord<TDefinition> | undefined;
	let queue: Promise<void> = Promise.resolve();

	function enqueue(step: () => Promise<void>): Promise<void> {
		const ran = queue.then(step);
		queue = ran.catch(() => undefined);
		return ran;
	}

	/**
	 * Take the address away from whatever holds it, and schedule its release.
	 *
	 * Marking the record retired is synchronous, so an open still in flight sees
	 * it the moment it resumes and gives back what it acquired instead of
	 * publishing a store nobody can reach.
	 */
	function retire(): void {
		const previous = live;
		live = undefined;
		if (previous === undefined || previous.retired) return;
		previous.retired = true;
		void enqueue(async () => {
			const acquired = previous.acquired;
			previous.acquired = undefined;
			await acquired?.close();
		});
	}

	/** Wait for everything already scheduled against the address to settle. */
	const settled = () => enqueue(async () => undefined);

	const open = (account: Account): DataSession<TDefinition> => {
		let publish!: (
			outcome: Result<ReplicaData<TDefinition>, DataOpenError>,
		) => void;
		const opened = new Promise<Result<ReplicaData<TDefinition>, DataOpenError>>(
			(resolve) => {
				publish = resolve;
			},
		);
		const record: SessionRecord<TDefinition> = {
			acquired: undefined,
			retired: false,
		};

		retire();
		live = record;

		void enqueue(async () => {
			if (record.retired) {
				publish(DataSessionError.SessionClosed());
				return;
			}
			// Contained rather than propagated. `openReplica` resolves a `Result`
			// and contains its own throws; a promise that breaks that anyway must
			// not leave this session pending forever, because a surface awaiting
			// `opened` would never leave its loading branch.
			const outcome = await openReplica({
				appId,
				definition,
				account,
			}).catch((cause: unknown) => DataSessionError.OpenerThrew({ cause }));

			if (outcome.error !== null) {
				if (live === record) live = undefined;
				publish(Err(outcome.error));
				return;
			}
			if (record.retired) {
				// Superseded while this was acquiring. Release what it took here,
				// because the retire that ran had nothing to release yet.
				await outcome.data.close();
				publish(DataSessionError.SessionClosed());
				return;
			}
			record.acquired = outcome.data;
			publish(Ok(outcome.data.store));
		});

		return Object.freeze({
			opened,
			close: () => {
				if (live === record) retire();
				// A superseded session was retired by the open that replaced it, so
				// this awaits the queue rather than closing again. That is also what
				// makes a second close wait for the first one's release instead of
				// resolving over a lock still being let go.
				return settled();
			},
			erase: async ({ afterClose } = {}) => {
				// Captured before the close, and spent after it. `afterClose` is
				// where the credential is cleared, so a client read later would
				// name nobody; this session already knows who it was opened for,
				// and that is the principal whose copy goes.
				const { principalId } = account;
				if (live === record) retire();
				await settled();
				// Throws out of `erase` on failure, which aborts before anything is
				// deleted. Removal is idempotent, so a retry is the same call.
				await afterClose?.();
				return eraseReplicaOf({ appId, definition, principalId });
			},
		});
	};

	return Object.freeze({
		appId,
		open,
		close: () => {
			retire();
			return settled();
		},
	});
}

/** What the handle tracks about one session, which no caller sees. */
type SessionRecord<TDefinition extends DataDefinition> = {
	/** What the open acquired, once it has. */
	acquired: OpenedDatabase<TDefinition> | undefined;
	/** Whether the handle has taken this session's turn away. */
	retired: boolean;
};
