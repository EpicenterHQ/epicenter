<script lang="ts">
 import SavedQueries from '../../src/lib/components/SavedQueries.svelte';
 import { app } from './application.js';
 let selected = $state('one');
 let panel: SavedQueries;
 export async function preflight() { await panel.preflight(); }
</script>
<div class="flex h-dvh flex-col bg-background text-foreground">
<label for="fixture-account">Gmail account</label>
<select id="fixture-account" bind:value={selected}><option value="one">one@example.com</option><option value="two">two@example.com</option></select>
<SavedQueries bind:this={panel} data={app} account={selected} />

</div>
