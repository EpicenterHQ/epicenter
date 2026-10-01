<script lang="ts">
	import { AppBoot } from '@epicenter/app-shell/boot-screens';
	import { auth } from '#platform/auth';
	import { resolve } from '$app/paths';
	import { openHoneycrispResources } from '$lib/resources.js';
	const open = new URL(location.href).searchParams.has('stopped')
		? undefined
		: (signal: AbortSignal, account: import('@epicenter/auth').Account | undefined) =>
				openHoneycrispResources(account, signal);
	import { page } from '$app/state';
	import SignInButton from '../components/SignInButton.svelte';
	import Notes from '../components/Notes.svelte';
	import NotesLinks from '../components/NotesLinks.svelte';
</script>

<AppBoot
	{auth}
	{open}
	signInHref={resolve('/connect')}
	signedOutHref={resolve('/')}
	appName="Honeycrisp"
	noun="notes"
>
	{#snippet children(app)}
		{#if page.params.collection === 'local'}
			<Notes data={app.local} />
		{:else if app.personal}
			<Notes data={app.personal} />
		{:else}
			<div class="flex h-dvh flex-col items-center justify-center gap-4">
				<NotesLinks />
				<p>Sign in to use Personal.</p>
				<SignInButton />
			</div>
		{/if}
	{/snippet}
</AppBoot>
