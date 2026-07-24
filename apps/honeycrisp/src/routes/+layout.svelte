<!--
	This layout owns the session boundary. Authentication selects the replica
	(ADR-0178), so the authenticated identity keys the whole data session:
	signing in or out disposes the running session and boots a new one over
	the selected replica. Navigation never re-keys; only an identity change
	does.
-->
<script lang="ts">
	import { FlushEditsOnHide } from '@epicenter/svelte';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { auth } from '#platform/auth';
	import HoneycrispSession from '$lib/HoneycrispSession.svelte';
	import '@epicenter/ui/app.css';

	let { children } = $props();

	function sessionIdentity(): string {
		const state = auth.state;
		return state.status === 'signed-in'
			? `signed-in:${auth.deployment.baseURL}:${state.principalId}`
			: 'signed-out';
	}
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

{#key sessionIdentity()}
	<HoneycrispSession {children} />
{/key}

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
<FlushEditsOnHide />
