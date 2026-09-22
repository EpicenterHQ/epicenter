<script lang="ts">
	import { resolve } from '$app/paths';
	import { AppBoot, SignInScreen } from '@epicenter/app-shell/boot-screens';
	import { auth } from '#platform/auth';
	import { openWhisperingResources } from '$lib/whispering/resources.js';
	import WhisperingShell from './_components/WhisperingShell.svelte';
	let { children: routeChildren } = $props();
	const params = new URLSearchParams(location.search);
	const connecting = !params.has('stopped') && params.has('connect');
	const open =
		connecting || params.has('stopped')
			? undefined
			: (
					signal: AbortSignal,
					account: import('@epicenter/auth').Account | undefined,
				) => openWhisperingResources(account, signal);
</script>

{#if connecting}
	<SignInScreen
		{auth}
		appName="Whispering"
		noun="recordings"
		onCancel={() => location.replace(location.pathname)}
	/>
{:else}
	<AppBoot
		{auth}
		{open}
		appName="Whispering"
		noun="recordings"
		signInHref={location.pathname + '?connect'}
		signedOutHref={resolve('/')}
	>
		{#snippet children(app, account)}
			<WhisperingShell openedApp={app} {account}
				>{@render routeChildren()}</WhisperingShell
			>
		{/snippet}
	</AppBoot>
{/if}
