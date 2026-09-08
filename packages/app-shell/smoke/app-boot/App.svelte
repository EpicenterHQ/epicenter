<script lang="ts">
 import { createBrowserAuth } from '@epicenter/auth';
 import { fromAuth } from '@epicenter/auth/svelte';
 import AppBoot from '../../src/boot-screens/app-boot.svelte';
 import Session from './Session.svelte';
 import { probe } from './probe.js';
 const local = new URL(location.href).searchParams.has('local');
 const events = probe.events;
 if (!local && !localStorage.getItem('probe.auth.server')) {
  localStorage.setItem('probe.auth.server', 'https://old.example');
  localStorage.setItem('probe.auth.instance:https://old.example', JSON.stringify({ token: 'old', principalId: 'instance' }));
 }
 Reflect.set(window, 'fetch', async () => {
  events.push('candidate-verified');
  return Response.json({ principalId: 'instance' });
 });
 const auth = fromAuth(createBrowserAuth({ appId: 'probe', baseURL: 'https://hosted.example' }));
 let session: Session | undefined = $state();
</script>
<AppBoot {auth} {local} appName="Probe" noun="changes" close={() => session?.close() ?? Promise.resolve()}>
 {#snippet children()}<Session bind:this={session} />{/snippet}
</AppBoot>
