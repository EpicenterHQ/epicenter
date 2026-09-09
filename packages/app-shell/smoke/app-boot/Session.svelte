<script lang="ts">
 import { getConnectionScreen } from '../../src/boot-screens/connection-screen-context.js';
 const connect = getConnectionScreen();
</script>
<button onclick={connect}>Choose connection</button>
