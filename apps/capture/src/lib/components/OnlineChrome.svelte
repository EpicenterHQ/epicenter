<!--
	The web app's header account of its store: the person's repository,
	online only, and the account.
-->
<script lang="ts">
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { webAuth } from '../auth.js';
	import type { CaptureList } from '../captures.svelte.js';

	let { list }: { list: CaptureList } = $props();
	const auth = webAuth();

	const status = $derived.by((): StatusLine => {
		if (auth.state.status === 'reauth-required')
			return {
				label: 'Sign in again',
				detail: 'Sign in again to edit your repository.',
				tone: 'warning',
			};
		if (list.error !== null) return { label: 'Offline', detail: list.error.message, tone: 'warning' };
		return { label: 'Online', tone: 'good' };
	});

	async function signIn() {
		const { error } = await auth.startSignIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}

	async function signOut() {
		const { error } = await auth.signOut();
		if (error !== null) toast.error('Could not sign out', { description: error.message });
	}
</script>

<StatusPopover summary={status} details={[{ name: 'Status', testid: 'status-files', line: status }]}>
	<StatusRow name="Where">
		<span class="font-medium" data-testid="status-where">Your repository</span>
		<span class="mt-0.5 block text-xs text-muted-foreground">
			Your Epicenter repository, capture. Online only: nothing is kept in this browser.
		</span>
	</StatusRow>
</StatusPopover>
<div class="ml-auto flex items-center gap-2">
	{#if auth.state.status !== 'signed-out'}
		{#if auth.state.status === 'reauth-required'}
			<Button size="sm" onclick={() => void signIn()}>Sign in again</Button>
		{/if}
		<Button variant="ghost" size="sm" onclick={() => void signOut()}>Sign out</Button>
	{/if}
</div>
