<!--
	The web app's header account of its store: whether the learner's
	repository answers, Sign in again when the sign-in ended, and the account.
-->
<script lang="ts">
	import { auth } from '#platform/auth';
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import { toast } from '@epicenter/ui/sonner';
	import type { ChromeProps } from '../platform.js';
	import AccountMenu from './AccountMenu.svelte';

	let { unreadable }: ChromeProps = $props();

	/** Whether the repository answers, in a line; `problem` says why it is a warning. */
	const status = $derived.by((): { label: string; problem?: string } => {
		if (auth.state.status === 'reauth-required')
			return { label: 'Sign in again', problem: 'Sign in again to see and edit your repository.' };
		return unreadable === null ? { label: 'Online' } : { label: 'Offline', problem: unreadable.message };
	});

	async function signInAgain() {
		// A successful start leaves this page for the sign-in page.
		const { error } = await auth.startSignIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}
</script>

<span class="text-xs max-md:mr-auto {status.problem === undefined ? 'text-muted-foreground' : 'text-destructive'}" role="status" title={status.problem} data-testid="status">{status.label}</span>
<div class="flex items-center gap-1 md:order-last md:ml-auto">
	{#if auth.state.status === 'reauth-required'}<Button size="sm" onclick={() => void signInAgain()}>Sign in again</Button>{/if}
	<LightSwitch variant="ghost" /><AccountMenu />
</div>
