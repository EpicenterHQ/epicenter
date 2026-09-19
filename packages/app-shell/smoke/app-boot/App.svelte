<script lang="ts">
 import AppBoot from '../../src/boot-screens/app-boot.svelte';
 import SignInScreen from '../../src/boot-screens/sign-in-screen.svelte';
 import Session from './Session.svelte';
 import { auth, definition, runtime } from './application.js';
 const connecting = new URL(location.href).searchParams.has('connect');
</script>
{#if connecting}
 <SignInScreen {auth} appName="Probe" noun="changes" onCancel={() => location.replace('/')} />
{:else}
 <AppBoot {auth} signInHref="/apps/probe/sign-in?connect" signedOutHref="/apps/probe/signed-out?connect" {definition} {runtime}
   appName="Probe" noun="changes">
  {#snippet children(app)}<Session {app} />{/snippet}
 </AppBoot>
{/if}
