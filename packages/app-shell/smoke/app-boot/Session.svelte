<script lang="ts">
 import { onDestroy } from 'svelte';
 import type { App } from '@epicenter/app/open';
 import type { definition } from './application.js';
 import { probe } from './probe.js';
 let { app }: { app: App<typeof definition> } = $props();
 // svelte-ignore state_referenced_locally
 app.device.kv.update({ text: 'accepted edit' });
 export async function preflight() { if (probe.refuse) throw new Error('Stop recording first.'); }
 let closing: Promise<void> | undefined;
 export function close() { return closing ??= (async () => {
  probe.events.push('producer-stop');
  await probe.producer;
  app.device.kv.update({ text: 'final producer edit' });
  probe.events.push('producer-done');
 })(); }
 probe.events.push('session-mounted');
 onDestroy(() => { void close().catch(() => {}); probe.events.push('session-destroyed'); });
 import { getConnectionScreen } from '../../src/boot-screens/connection-screen-context.js';
 const connect = getConnectionScreen();
</script>
<button onclick={connect}>Choose connection</button>
