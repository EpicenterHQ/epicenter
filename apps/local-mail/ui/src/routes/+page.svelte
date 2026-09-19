<script lang="ts">
	import { AppBoot, SignInScreen } from '@epicenter/app-shell/boot-screens';
	import { auth, serverSelection } from '#platform/auth';
	import { mailDefinition } from '$lib/data.js';
	import MailShell from '$lib/components/MailShell.svelte';

	const connecting = !auth?.getState().account || new URLSearchParams(location.search).has('connect');
</script>

{#if !auth || connecting}
	<SignInScreen {auth} selection={serverSelection} appName="Local Mail" noun="saved queries and mail"
		onCancel={new URLSearchParams(location.search).has('connect') ? () => location.replace('/') : undefined} />
{:else}
	<AppBoot {auth} definition={mailDefinition} canChangeServer={serverSelection !== undefined}

		appName="Local Mail" noun="saved queries and mail" connectionHref={location.pathname + '?connect'}>
		{#snippet children(app)}
			{#if app.account}<MailShell {app} />{/if}
		{/snippet}
	</AppBoot>
{/if}
