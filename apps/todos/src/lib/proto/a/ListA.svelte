<script lang="ts">
	import Shown from '../Shown.svelte';
	import { todos } from './app.js';
</script>

<Shown option="a" {todos} />
