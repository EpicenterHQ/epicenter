<script lang="ts">
	import { resolve } from '$app/paths';
	import { AppBoot, SignInScreen } from '@epicenter/app-shell/boot-screens';
	import { auth } from '#platform/auth';
	import { openMailResources } from '$lib/resources.js';
	import MailShell from '$lib/components/MailShell.svelte';

	const params = new URLSearchParams(location.search);
	const connecting =
		!params.has('stopped') && (!auth.getState().account || params.has('connect'));
	const account = auth.getState().account;
	const open =
		!connecting && account && !new URLSearchParams(location.search).has('stopped')
			? (signal: AbortSignal) => openMailResources(account, signal)
			: undefined;
</script>

{#if connecting}
	<SignInScreen {auth} appName="Local Mail" noun="saved queries and mail"
		onCancel={new URLSearchParams(location.search).has('connect') ? () => location.replace(resolve('/')) : undefined} />
{:else}
	<AppBoot {auth} {open}

		appName="Local Mail" noun="saved queries and mail"
		signInHref={location.pathname + '?connect'}
		signedOutHref={resolve('/')}
	>
		{#snippet children(app)}
			<MailShell {app} />
		{/snippet}
	</AppBoot>
{/if}
