<script lang="ts">
	import type { Account } from "@epicenter/auth";
	import { CannotOpenScreen } from '@epicenter/app-shell/boot-screens';
	import { auth } from '$lib/auth';
	import { Loading } from '@epicenter/ui/loading';
	import { epicenter } from '$lib/epicenter.svelte.js';
	import VocabShell from './VocabShell.svelte';

	/**
	 * One session, for one principal.
	 *
	 * Opened in the script body because the parent keys this on the principal,
	 * so a new principal is a new instance. The handle serializes, so this open
	 * runs after the previous session's release even though Svelte creates the
	 * new keyed branch first.
	 */
	let { account }: { account: Account } = $props();
	/* svelte-ignore state_referenced_locally */
	let session = $state.raw(epicenter.open(account));
	$effect(() => () => void session.close());

	/**
	 * Sign out, and remove this account's copy from this device.
	 *
	 * The ORDER is the design. The session captures the principal, closes so the
	 * erase can take the lock, clears the credential in `afterClose`, and only
	 * then deletes. Clearing before deleting is what makes an interrupted removal
	 * safe on a shared device: the next person meets a sign-in door rather than
	 * the owner's conversations.
	 *
	 * **It does not reopen.** A failed removal leaves the copy that is still
	 * there, and reopening it would show a person data they asked to be rid of.
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
	<Loading class="h-dvh" label="Opening your conversations…" />
{:then { data, error }}
	{#if error !== null}
		<CannotOpenScreen
			appName="Vocab"
			noun="conversations"
			{error}
			retry={() => (session = epicenter.open(account))}
		/>
	{:else}
		<VocabShell {account} {data} {removeLocalData} />
	{/if}
{/await}
