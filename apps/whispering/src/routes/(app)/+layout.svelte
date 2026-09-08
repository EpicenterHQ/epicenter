<!--
	The (app) route layout is the boot node: the narrowest node that is NOT
	shared with `/auth/callback` or `/recording-overlay` (ADR-0345). It mounts
	once per launch and persists across navigation inside the group, so the
	store is opened once and the UI session is built once.

	**This node decides who is looking; the session component opens.** Whispering
	has many routes at `/`, so its protected surface is a group and the boot is
	this layout rather than a page: `/auth/callback` and `/recording-overlay` are
	siblings of the group and never reach it (ADR-0345).

	The auth read TRACKS. A sign-out flips the `{#if}` and the session's cleanup
	closes; a different principal remounts the `{#key}`; a credential degrading
	to `reauth-required` changes neither, so a person keeps recording while sync
	reports the refusal (ADR-0350). Signing in is a door (ADR-0342, rejected):
	nothing opens while signed out, because a recording that was never anywhere
	is the loss this refuses to allow.
-->
<script lang="ts">
	import { SignInScreen } from '@epicenter/app-shell/boot-screens';
	import { auth } from '#platform/auth';
	import RecordingsSession from './_components/RecordingsSession.svelte';

	let { children } = $props();
</script>

{#if auth.state.status === 'signed-out'}
	<SignInScreen {auth} appName="Whispering" noun="recordings" />
{:else}
	{#key auth.state.account}
		<RecordingsSession account={auth.state.account}>{@render children()}</RecordingsSession>
	{/key}
{/if}
