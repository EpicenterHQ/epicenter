<script lang="ts">
 import AppBoot from '../../src/boot-screens/app-boot.svelte';
 import SignInScreen from '../../src/boot-screens/sign-in-screen.svelte';
 import Session from './Session.svelte';
 import { auth, definition, runtime } from './application.js';
 let session: Session | undefined = $state();
 const connecting = new URL(location.href).searchParams.has('connect');
</script>
{#if connecting}
 <SignInScreen auth={auth.auth ?? undefined} selection={auth} appName="Probe" noun="changes" onCancel={() => location.replace('/')} />
{:else}
 <AppBoot auth={auth.auth ?? undefined} selection={auth} {definition} {runtime}
  ui={session} appName="Probe" noun="changes">
  {#snippet children(app)}<Session {app} bind:this={session} />{/snippet}
 </AppBoot>
{/if}
