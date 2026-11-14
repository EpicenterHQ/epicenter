<!--
	The header's account of the store when the folder is the person's
	repository (ADR-0786): online only, whether it answers now, and Sign in
	again when the sign-in ended. Nothing is kept in this browser.
-->
<script lang="ts">
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import { Button } from '@epicenter/ui/button';
	import { toast } from 'svelte-sonner';
	import { account, folder } from '../app.js';

	const status = $derived.by((): StatusLine => {
		if (account.state().status === 'reauth-required')
			return { label: 'Sign in again', detail: 'Sign in again to record into your repository.', tone: 'warning' };
		const unavailable = folder.unavailable();
		if (unavailable !== null) return { label: 'Offline', detail: unavailable.message, tone: 'warning' };
		return { label: 'Online', tone: 'good' };
	});

	async function signIn() {
		const { error } = await account.startSignIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}
</script>

<StatusPopover summary={status} details={[{ name: 'Files', testid: 'status-files', line: status }]}>
	<StatusRow name="Kept in">
		<span class="font-medium" data-testid="status-where">Your repository</span>
		<span class="mt-0.5 block text-xs text-muted-foreground" data-testid="status-folder">
			Your Epicenter repository, whispering: a Markdown note per recording beside its audio. Online only: nothing is kept in this browser.
		</span>
	</StatusRow>
</StatusPopover>
{#if account.state().status === 'reauth-required'}
	<Button size="sm" onclick={() => void signIn()}>Sign in again</Button>
{/if}
