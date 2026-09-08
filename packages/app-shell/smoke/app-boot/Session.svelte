<script lang="ts">
 import { tick } from 'svelte';
 import { compileData, defineData, field } from '@epicenter/data/definition';
 import { createStoreOverPort } from '../../../data/src/store/store';
 import { getConnectionScreen } from '../../src/boot-screens/connection-screen-context';
 import { Ok } from 'wellcrafted/result';
 import { probe } from './probe.js';
 const definition = compileData(defineData({ id: 'test.boot-probe', kv: { text: field.string() }, tables: {} }));
 if (definition.error) throw definition.error;
 const app = createStoreOverPort({ definition: definition.data, acquire: async () => Ok({
  durable: { async commit() { probe.events.push('commit-start'); await probe.commit; probe.events.push('commit-end'); } },
  loaded: { updates: [], outbox: [], cursor: 0, lastId: 0 }
 }) });
 const ready = app.ready.then((result) => { if (result.error) throw result.error; app.view.kv.update({ text: 'accepted edit' }); return 'Choose connection'; });
 const connect = getConnectionScreen();
 let closing: Promise<void> | undefined;
 let showing = $state(true);
 export function close() {
  if (probe.refuse) return Promise.reject(new Error('Stop recording first.'));
  closing ??= (async () => {
   showing = false;
   probe.events.push('producer-stop');
   await tick();
   await probe.producer;
   app.view.kv.update({ text: 'final producer edit' });
   probe.events.push('producer-done');
   await app.close();
   probe.events.push('closed');
  })();
  return closing;
 }
 $effect(() => () => void close());
</script>
{#if showing}{#await ready}<p>Opening fixture</p>{:then label}<button onclick={connect}>{label}</button>{/await}{:else}<p>Closing your changes…</p>{/if}
