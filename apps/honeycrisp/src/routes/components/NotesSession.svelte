<script lang="ts">
	import type { Account } from "@epicenter/auth";
	import { CannotOpenScreen } from '@epicenter/app-shell/boot-screens';
	import { auth } from '#platform/auth';
	import { Loading } from '@epicenter/ui/loading';
	import { epicenter } from '$lib/epicenter.svelte.js';
	import StoreShell from './StoreShell.svelte';

	/**
	 * One session, for one principal.
	 *
	 * Opened in the script body rather than an effect, because the parent keys
	 * this component on the principal, so a new principal is a new instance and
	 * the body is the one thing that runs per instance. That is safe despite
	 * Svelte creating the new keyed branch before destroying the old one: the
	 * handle serializes, so this open runs after the previous session's release.
	 *
	 * The cleanup-only effect is the whole lifecycle. Closing releases the Web
	 * Lock, the socket, and the page-hide listener together (ADR-0340).
	 */
	let { account }: { account: Account } = $props();
	/* svelte-ignore state_referenced_locally */
	let session = $state.raw(epicenter.open(account));
	$effect(() => () => void session.close());

	/**
	 * Sign out, and remove this account's copy from this device.
	 *
	 * The ORDER is the design. Capture the principal while a client still names
	 * one, close the session so the erase can take the lock, clear the credential,
	 * then delete. Clearing before deleting is what makes an interrupted removal
	 * safe on a shared device: the next person meets a sign-in door rather than
	 * the owner's notes, and the owner signing back in sees what is left and
	 * removes again.
	 *
	 * **It does not reopen.** A failed removal leaves the copy that is still
	 * there, and reopening it would be this component deciding that a person who
	 * asked for their data to be gone should be shown it again. The popover
	 * reloads on success and reports the failure otherwise.
	 */
	async function removeLocalData() {
		const erased = await session.erase({
			afterClose: async () => {
				const out = await auth.signOut();
				if (out.error !== null) throw out.error;
			},
		});
		if (erased.error !== null) throw erased.error;
	}
</script>

{#await session.opened}
	<Loading class="h-dvh" label="Opening your notes…" />
{:then { data, error }}
	{#if error !== null}
		<CannotOpenScreen
			appName="Honeycrisp"
			noun="notes"
			{error}
			retry={() => (session = epicenter.open(account))}
		/>
	{:else}
		<StoreShell {data} {removeLocalData} />
	{/if}
{/await}
