<script lang="ts">
	import type { Account } from "@epicenter/auth";
	import { CannotOpenScreen } from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
	import { auth } from '#platform/auth';
	import { eraseWhisperingBlobs } from '#platform/blobs';
	import { epicenter } from '$lib/epicenter.svelte';
	import type { WhisperingAccountData } from '$lib/whispering/app';
	import WhisperingShell from './WhisperingShell.svelte';

	/**
	 * One session, for one principal.
	 *
	 * Opened in the script body because the parent keys this on the principal,
	 * so a new principal is a new instance. The handle serializes, so this open
	 * runs after the previous session's release even though Svelte creates the
	 * new keyed branch before destroying the old one.
	 */
	let { children, account }: { children: import("svelte").Snippet; account: Account } = $props();

	/* svelte-ignore state_referenced_locally */
	let session = $state.raw(epicenter.open(account));
	$effect(() => () => void session.close());

	/**
	 * Sign out, and remove this account's recordings and their audio from this
	 * device.
	 *
	 * The ORDER is the design, and it is Honeycrisp's with one more step.
	 * Capture the principal while a client still names one, close the session
	 * so the erase can take the lock, clear the credential, delete the
	 * generations, THEN delete the audio (ADR-0349: a second explicit delete
	 * against the same captured principal, never a widened filter). Clearing
	 * before deleting is what makes an interrupted removal safe on a shared
	 * device, and removal is idempotent, so a retry is the same call.
	 *
	 * The audio scope is read off the opened replica, the same stamp the blob
	 * store was built from, not off auth: by the time the audio delete runs the
	 * credential is already gone and a client read would name nobody.
	 *
	 * **It does not reopen.** A failed removal leaves what is still there, and
	 * the popover reports the failure; reopening would show a person who asked
	 * for their data to be gone that same data.
	 *
	 * Defined only where the platform can remove one account's audio and leave
	 * another's, which is the browser build today. The desktop leaf exports
	 * null, and the popover then offers plain sign-out and nothing else.
	 */
	// A local, because a narrowing on an import does not survive into a closure.
	const eraseAudio = eraseWhisperingBlobs;
	const removeLocalData =
		eraseAudio === null
			? undefined
			: async (opened: WhisperingAccountData) => {
					const scope = {
						appId: opened.appId,
						principalId: opened.principalId,
					};
					const erased = await session.erase({
						afterClose: async () => {
							const out = await auth.signOut();
							if (out.error !== null) throw out.error;
						},
					});
					if (erased.error !== null) throw erased.error;
					const audio = await eraseAudio(scope);
					if (audio.error !== null) throw audio.error;
				};
</script>

{#await session.opened}
	<Loading class="h-dvh" label="Opening your recordings…" />
{:then { data, error }}
	{#if error !== null}
		<CannotOpenScreen
			appName="Whispering"
			noun="recordings"
			{error}
			retry={() => (session = epicenter.open(account))}
		/>
	{:else}
		<WhisperingShell
			{account}
			{data}
			removeLocalData={removeLocalData && (() => removeLocalData(data))}
		>
			{@render children()}
		</WhisperingShell>
	{/if}
{/await}
