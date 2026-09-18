<script lang="ts">
 import { tick } from 'svelte';
 import AppBoot from '../../src/boot-screens/app-boot.svelte';
 import Session from './Session.svelte';
 import { auth, opening, departure } from './application.js';
 import { probe } from './probe.js';
 departure.attachUi({
  async preflight() { if (probe.refuse) throw new Error('Stop recording first.'); },
  async quiesce() {
   probe.events.push('producer-stop');
   await tick();
   await probe.producer;
   (await opening)?.device.kv.update({ text: 'final producer edit' });
   probe.events.push('producer-done');
  },
 });
</script>
<AppBoot startup={auth} {departure} {opening} appName="Probe" noun="changes">
 <Session />
</AppBoot>
