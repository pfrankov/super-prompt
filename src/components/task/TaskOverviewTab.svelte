<script lang="ts">
  import type { Task } from '../../lib/types'
  import TaskEditor from './TaskEditor.svelte'

  let { task = $bindable() as Task }: { task: Task } = $props()
</script>

<div class="surface">
  <TaskEditor bind:task />
</div>

<style>
  .surface { padding: var(--s-5); }
</style>