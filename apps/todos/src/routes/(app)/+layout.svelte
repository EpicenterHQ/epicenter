<!--
	Todos' root over its folder (ADR-0766): `<WhenOpen>` shows a spinner while
	the folder opens, Recovery when it cannot, and the pages once it has. On
	the web the folder is the signed-in person's repository, so a signed-out
	page asks to sign in instead. The sign-in callback is outside this group.
-->
<script lang="ts">
	import WhenOpen from '@epicenter/svelte/when-open';
	import { trackReads } from '@epicenter/svelte/tracked';
	import { account, folder } from '$lib/app.js';
	import SignIn from '$lib/components/SignIn.svelte';

	let { children } = $props();

	/** The web build's sign-in, read as it changes; the desktop window has none. */
	function sessionOf(signIn: NonNullable<typeof account>) {
		return trackReads((listener) => signIn.subscribe(listener), {
			state: () => signIn.getState(),
		});
	}
	const session = account && sessionOf(account);
</script>

{#if account && session?.state.status === 'signed-out'}
	<SignIn {account} />
{:else}
	<WhenOpen app="Todos" {folder}>{@render children()}</WhenOpen>
{/if}
