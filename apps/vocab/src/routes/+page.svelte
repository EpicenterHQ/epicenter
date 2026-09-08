<script lang="ts">
	import { SignInScreen } from '@epicenter/app-shell/boot-screens';
	import { auth } from '$lib/auth';
	import ConversationsSession from './components/ConversationsSession.svelte';

	// The boot node: it decides who is looking and keys one session on the
	// answer. Vocab's protected surface is one route at `/`, so the page is the
	// narrowest node not shared with `/auth/callback` (ADR-0345).
	//
	// The read tracks. A sign-out flips this `{#if}`, a different principal
	// remounts the `{#key}`, and a credential degrading to `reauth-required`
	// changes neither, so editing continues while sync reports it (ADR-0350).
	// Signing in is a door (ADR-0342, rejected): nothing opens while signed out.
</script>

{#if auth.state.status === 'signed-out'}
	<SignInScreen {auth} appName="Vocab" noun="conversations" />
{:else}
	{#key auth.state.account}
		<ConversationsSession account={auth.state.account} />
	{/key}
{/if}
