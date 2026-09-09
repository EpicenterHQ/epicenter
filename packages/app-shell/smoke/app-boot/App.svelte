<script lang="ts">
 import { tick } from 'svelte';
 import AppBoot from '../../src/boot-screens/app-boot.svelte';
 import Session from './Session.svelte';
 import { auth, app, ready, departure } from './application.js';
 import { probe } from './probe.js';
 let showing = $state(true);
 departure.attachUi({
  async preflight() { if (probe.refuse) throw new Error('Stop recording first.'); },
  async quiesce() {
   showing = false;
   probe.events.push('producer-stop');
   await tick();
   await probe.producer;
   app?.view.kv.update({ text: 'final producer edit' });
   probe.events.push('producer-done');
  },
 });
</script>
<AppBoot startup={auth} {departure} hasApp={app !== null} appName="Probe" noun="changes">
 {#if showing}{#await ready}<p>Opening fixture</p>{:then}<Session />{/await}{/if}
</AppBoot>
