<script lang="ts">
 import SavedQueries from '../../src/lib/components/SavedQueries.svelte';
 import { opening } from './application.js';

 let selected = $state('one');
</script>
<div class="flex h-dvh flex-col bg-background text-foreground">
<label for="fixture-account">Gmail account</label>
<select id="fixture-account" bind:value={selected}><option value="one">one@example.com</option><option value="two">two@example.com</option></select>
{#await opening then app}<SavedQueries data={app.personal} account={selected} />{/await}

</div>
