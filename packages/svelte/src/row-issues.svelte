<script lang="ts">
	import { describeIssue, type RowIssue } from '@epicenter/folder';

	let { issues }: { issues: readonly RowIssue[] } = $props();
</script>

<ul>
	{#each issues as issue}
		<li>{describeIssue(issue)}</li>
	{/each}
</ul>
