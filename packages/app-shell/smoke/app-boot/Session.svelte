<script lang="ts">
 import { onDestroy } from 'svelte';
 import { probe } from './probe.js';
 probe.events.push('session-mounted');
 onDestroy(() => { probe.events.push('session-destroyed'); });
 import { getConnectionScreen } from '../../src/boot-screens/connection-screen-context.js';
 const connect = getConnectionScreen();
</script>
<button onclick={connect}>Choose connection</button>
