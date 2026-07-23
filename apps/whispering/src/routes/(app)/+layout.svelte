<!--
	The (app) route layout owns the session boundary. Authentication selects
	the replica (ADR-0178), so the authenticated identity keys the whole data
	session: signing in or out disposes the running session and boots a new
	one over the selected replica. Navigation never re-keys; only an identity
	change does.
-->
<script lang="ts">
	import { auth } from '#platform/auth';
	import SessionShell from './_components/SessionShell.svelte';

	let { children } = $props();

	function sessionIdentity(): string {
		const state = auth.state;
		return state.status === 'signed-in'
			? `signed-in:${auth.deployment.baseURL}:${state.principalId}`
			: 'signed-out';
	}
</script>

{#key sessionIdentity()}
	<SessionShell {children} />
{/key}
