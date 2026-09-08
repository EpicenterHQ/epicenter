/// <reference lib="dom" />

/**
 * Opening a person's Epicenter Data, in every runtime.
 *
 * Its own module because the handle composes it rather than contains it. It
 * lived in `browser.ts` while a browser was the only caller, which left the
 * desktop leaf importing an opener from a file named for the other runtime: a
 * reader would fairly conclude the desktop build falls back to the browser
 * one, and it does not. Neither leaf reaches it now; the handle does, once,
 * because there is one opener for the same reason there was one answer.
 *
 * **The store is client-owned everywhere.** The host serves bundles and brokers
 * credentials and owns no application data (ADR-0226, ADR-0227). The desktop
 * leaf adds nothing before this call and nothing after it: a deployed app is a
 * trusted app (ADR-0334), so both leaves reach the same store the same way.
 */

import type { Account } from '@epicenter/auth';
import {
	eraseGenerations,
	type OpenedDatabase,
	openDatabase,
	resolveGeneration,
	type StoreError,
} from '@epicenter/data/browser';
import type {
	DataDefinition,
	DataDefinitionParseError,
} from '@epicenter/data/definition';
import { persistOnHide } from '@epicenter/data/flush-on-hide';
import { attachStoreSync, type SyncConnection } from '@epicenter/data/sync';
import type { PrincipalId } from '@epicenter/principal';
import { defineErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';

const log = createLogger('app');

/**
 * A dial that failed for a reason time might repair, which nobody is holding a
 * promise for.
 *
 * The driver's own backoff owns the retry, so warning is the whole of the
 * handling. It is a tagged variant rather than a message minted here so the
 * event has a stable `name` to filter on.
 */
const EpicenterDataBackgroundError = defineErrors({
	SyncTransportFailed: ({ cause }: { cause: unknown }) => ({
		message: 'A sync dial failed for this replica.',
		cause,
	}),
});

/**
 * Open the newest generation of this definition's store, minting one when the
 * account has never held it, and attach sync to it.
 *
 * The store is a replica of `account`, because an authority mints every
 * generation. The application supplies the account, since it is what knows
 * which principal it is acting as.
 *
 * `appId` is the OPENING application's, which is not the data id: it is the
 * segment of the address that keeps two applications naming one data id on
 * their own replicas (ADR-0324, ADR-0304). It comes from the handle rather than
 * from a caller, which is what the handle is for, and nothing verifies it: a
 * deployed app is a trusted app (ADR-0334).
 *
 * Two calls, and the first one is not "read the cache". `resolveGeneration`
 * asks the account which generations exist when this device holds none, so a
 * second device joins the notebook the first one made instead of minting a
 * rival. This used to create one whenever the local cache was empty, which
 * forked one account's notes into two histories on the second machine that
 * opened them.
 *
 * **What this acquires, it hands back a closer for.** Opening takes three
 * things: the document and its Web Lock, a socket, and a page-hide listener.
 * They live for one session, which is shorter than the page: the session
 * component's cleanup closes when its `{#key}` remounts or its `{#if}` flips
 * (ADR-0350). The store cannot close itself, because a store is one of the
 * three (ADR-0340).
 */
export async function openReplica<TDefinition extends DataDefinition>({
	appId,
	definition,
	account: address,
}: {
	appId: string;
	definition: TDefinition;
	/**
	 * The account, read at one instant rather than the live client.
	 *
	 * The caller passes a stable Account, so the address this opens is the
	 * one the caller decided on, even if the client signs in as somebody else
	 * while this is still queued behind a release.
	 */
	account: Account;
}): Promise<
	Result<OpenedDatabase<TDefinition>, StoreError | DataDefinitionParseError>
> {
	const resolved = await resolveGeneration(definition, {
		appId,
		account: address,
	});
	if (resolved.error !== null) return resolved;

	const opened = await openDatabase(definition, {
		appId,
		generation: resolved.data.generation,
		account: address,
	});
	if (opened.error !== null) return opened;

	// The account is the transport: `openWebSocket` carries the bearer as a
	// subprotocol, because a browser upgrade cannot set `Authorization`, and an
	// `AuthClient` satisfies the port structurally with no adapter.
	//
	// A throw here costs sync and not the notes, which is the same answer a
	// permanent denial already gets (ADR-0292): the store opened from local
	// state before any of this was attempted and works offline without it. It
	// is contained rather than raised because raising it would reject a promise
	// this package promised would resolve a `Result`, and the error it would
	// carry is not one this package can mint. `sync.status()` answers
	// `undefined`, which is what a surface renders as a quiet status line.
	//
	// Nothing is known to reach this: every input `attachStoreSync` reads was
	// canonicalized by the open above.
	let connection: SyncConnection | undefined;
	try {
		connection = attachStoreSync({
			store: opened.data.store,
			transport: address,
			onTransportError: (cause) =>
				log.warn(EpicenterDataBackgroundError.SyncTransportFailed({ cause })),
		});
	} catch (cause) {
		log.warn(EpicenterDataBackgroundError.SyncTransportFailed({ cause }));
	}

	// Durable work is what a reconnect offers the authority, so a flush that
	// never happened is work the account never hears about either. The page
	// telling us it is going is the last chance to ask for one, and it is asked
	// here rather than by an application: the store's lifetime is this page's
	// (ADR-0088), which is exactly the listener's, and an application that
	// forgot this would lose the last few seconds of typing with no error
	// anywhere. `FlushEditsOnHide` does the other half, blurring the focused
	// element so a commit-on-blur input writes into the store first.
	const stopHideFlush = persistOnHide(() =>
		opened.data.store.persistence.flush(),
	);

	// All three in one hand. The store's own disposal would free one of them and
	// leave a connection dialling against a document whose every verb throws,
	// which is why it is not on the store any more (ADR-0340).
	return Ok({
		store: opened.data.store,
		close: async () => {
			connection?.[Symbol.dispose]();
			stopHideFlush();
			await opened.data.close();
		},
	});
}

/**
 * Erase this account's copy of this definition on this device.
 *
 * It takes a principal rather than a client, and that is the whole reason this
 * signature changed. The destructive exit clears the credential BEFORE it
 * deletes, so that a crash between the two leaves the next person at this
 * device meeting a sign-in door rather than the owner's notes. A live client
 * read after that point would name nobody and refuse, so the caller captures
 * the principal while it still can and spends it here.
 *
 * Scoped to that principal, because the principal is a segment of the address:
 * forgetting one person's copy on a shared device leaves the other person's
 * alone, and there is no reachable way to erase somebody else's.
 *
 * Every generation rather than one, because a person forgetting their copy
 * means all of it: erasing only the newest would leave the number below it to
 * be opened next boot.
 */
export async function eraseReplicaOf({
	appId,
	definition,
	principalId,
}: {
	appId: string;
	definition: DataDefinition;
	principalId: PrincipalId;
}): Promise<Result<void, StoreError>> {
	const erased = await eraseGenerations({
		appId,
		principalId,
		dataId: definition.id,
	});
	return erased.error !== null ? erased : Ok(undefined);
}
