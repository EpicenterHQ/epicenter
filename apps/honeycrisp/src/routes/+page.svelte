<script lang="ts">
	import { SignInScreen } from '@epicenter/app-shell/boot-screens';
	import { auth } from '#platform/auth';
	import NotesSession from './components/NotesSession.svelte';

	// The notes are here, at the one URL this application has. The generation
	// used to be a route parameter, resolved by `/account` and opened by
	// `/account/[generation]`; nobody chose that number, no link carried it, and
	// the handle resolves it now (ADR-0339), so the parameter and both routes
	// went with it.
	//
	// **This is the node that decides who is looking, and it is a page rather
	// than the layout** because the layout also wraps `/auth/callback`, which
	// must claim no Web Lock, touch no IndexedDB, and make no round trip on its
	// way through. This is the narrowest node not shared with it, which for a
	// one-route application is the page itself (ADR-0345).
	//
	// The read TRACKS, which is what deleted the reload. A sign-out flips this
	// `{#if}` and the session component's cleanup closes; a different principal
	// remounts the `{#key}`; a credential degrading to `reauth-required` changes
	// neither, so editing continues while sync reports the refusal (ADR-0350).
	//
	// Signing in is a door (ADR-0342, rejected): a signed-out person meets the
	// screen and nothing opens, because an ephemeral store would lose their work
	// without ever saying so.
</script>

{#if auth.state.status === 'signed-out'}
	<SignInScreen auth={auth} appName="Honeycrisp" noun="notes" />
{:else}
	{#key auth.state.account}
		<NotesSession account={auth.state.account} />
	{/key}
{/if}
