<script lang="ts">
	import { AppBoot, SignInScreen } from '@epicenter/app-shell/boot-screens';
	import { auth, serverSelection } from '#platform/auth';
	import { mailDefinition } from '$lib/data.js';
	import MailShell from '$lib/components/MailShell.svelte';

	const connecting = !auth?.getState().account || new URLSearchParams(location.search).has('connect');
	let shell: MailShell | undefined = $state();
</script>

{#if connecting}
	<SignInScreen {auth} selection={serverSelection} appName="Local Mail" noun="saved queries and mail"
		onCancel={new URLSearchParams(location.search).has('connect') ? () => location.replace('/') : undefined} />
{:else}
	<AppBoot {auth} definition={mailDefinition} selection={serverSelection}
		ui={shell}
		appName="Local Mail" noun="saved queries and mail">
		{#snippet children(app)}
			{#if app.account}<MailShell bind:this={shell} {app} />{/if}
		{/snippet}
	</AppBoot>
{/if}
