<script lang="ts">
 import { onDestroy } from 'svelte';
 import { registerAppCleanup } from '../../src/boot-screens/app-cleanup.js';
 import type { App } from '@epicenter/app/open';
 import { auth, type definition } from './application.js';
 import { fromAuth } from '@epicenter/auth/svelte';
 import SignInPanel from '../../src/account-popover/sign-in-panel.svelte';
 const reactiveAuth = fromAuth(auth);
 const reauth = new URL(location.href).searchParams.has('reauth');
 import { probe } from './probe.js';
 let { app }: { app: App<typeof definition> } = $props();
 // svelte-ignore state_referenced_locally
 app.device.kv.update({ text: 'accepted edit' });
 async function preflight() { probe.events.push('preflight'); if (probe.holdConfirmation) await probe.confirmation; if (probe.refuse) throw new Error('Stop recording first.'); }
 async function close() {
  probe.events.push('producer-stop');
  await probe.producer;
  app.device.kv.update({ text: 'final producer edit' });
  probe.events.push('producer-done');
 }
 probe.events.push('session-mounted');
 onDestroy(() => { probe.events.push('session-destroyed'); });
 import { getConnectionScreen, getSignOut } from '../../src/boot-screens/connection-screen-context.js';
 const connect = getConnectionScreen();
 const signOut = getSignOut();
 const leave = auth.getState().account ? (() => { void signOut?.().catch(() => {}); }) : connect;
 registerAppCleanup({ preflight, close });
 if (new URL(location.href).searchParams.has('duplicate')) registerAppCleanup({ close });
</script>
<button onclick={leave}>Leave session</button>

{#if reauth}<SignInPanel auth={reactiveAuth} syncNoun="changes" />{/if}
