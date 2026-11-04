<!--
	`#platform/chrome` in the web build: the header's account of its store,
	whether the learner's repository answers, Sign in again when the sign-in
	ended, and the account.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import { toast } from '@epicenter/ui/sonner';
	import { account } from '../app.js';
	import AccountMenu from './AccountMenu.svelte';

	let {
		unreadable,
	}: {
		/** Why the words or chats did not list, if they did not. */
		unreadable: { message: string } | null;
	} = $props();

	/** Whether the repository answers, in a line; `problem` says why it is a warning. */
	const status = $derived.by((): { label: string; problem?: string } => {
		if (account.state().status === 'reauth-required')
			return { label: 'Sign in again', problem: 'Sign in again to see and edit your repository.' };
		return unreadable === null ? { label: 'Online' } : { label: 'Offline', problem: unreadable.message };
	});

	async function signInAgain() {
		// A successful start leaves this page for the sign-in page.
		const { error } = await account.startSignIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}
</script>

<span class="text-xs max-md:mr-auto {status.problem === undefined ? 'text-muted-foreground' : 'text-destructive'}" role="status" title={status.problem} data-testid="status">{status.label}</span>
<div class="flex items-center gap-1 md:order-last md:ml-auto">
	{#if account.state().status === 'reauth-required'}<Button size="sm" onclick={() => void signInAgain()}>Sign in again</Button>{/if}
	<LightSwitch variant="ghost" /><AccountMenu />
</div>
