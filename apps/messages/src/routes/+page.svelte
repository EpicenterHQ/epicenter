<!--
	Messages' drafts and send attempts are this browser's files for this
	origin (OPFS), which `Startup` opens before the app renders, under the
	layout's boundary. Messages never signs in, so nothing uploads.
-->
<script lang="ts">
	import Startup from '$lib/Startup.svelte';
</script>

<Startup />
