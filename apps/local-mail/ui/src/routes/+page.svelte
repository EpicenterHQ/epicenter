<script lang="ts">
	import { resolve } from '$app/paths';
	import { AppBoot, SignInScreen } from '@epicenter/app-shell/boot-screens';
	import { auth } from '#platform/auth';
	import { mailDefinition } from '$lib/data.js';
	import MailShell from '$lib/components/MailShell.svelte';

	const connecting = !auth.getState().account || new URLSearchParams(location.search).has('connect');
</script>

{#if connecting}
	<SignInScreen {auth} appName="Local Mail" noun="saved queries and mail"
		onCancel={new URLSearchParams(location.search).has('connect') ? () => location.replace(resolve('/')) : undefined} />
{:else}
	<AppBoot {auth} definition={mailDefinition}

		appName="Local Mail" noun="saved queries and mail"
		signInHref={location.pathname + '?connect'}
		signedOutHref={resolve('/')}
	>
		{#snippet children(app)}
			{#if app.account}<MailShell {app} />{/if}
		{/snippet}
	</AppBoot>
{/if}
