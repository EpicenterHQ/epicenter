<script lang="ts">
	import type { Account } from "@epicenter/auth";
	import { CannotOpenScreen } from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
	import { epicenter } from '$lib/epicenter.svelte.js';
	import VocabShell from './VocabShell.svelte';

	// One captured App per keyed session.
	let { account }: { account: Account } = $props();
	/* svelte-ignore state_referenced_locally */
	const app = epicenter.openAccount(account);
	$effect(() => () => void app.close());

	const removeLocalData = undefined;
</script>

{#await app.ready}
	<Loading class="h-dvh" label="Opening your conversations…" />
{:then { error }}
	{#if error !== null}
		<CannotOpenScreen
			appName="Vocab"
			noun="conversations"
			{error}
			retry={() => location.reload()}
		/>
	{:else}
		<VocabShell {account} data={app} {removeLocalData} />
	{/if}
{/await}
