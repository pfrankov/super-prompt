<script lang="ts">
  import { untrack } from 'svelte'
  import type { Task } from '../../../src/lib/types'
  import ImproveWorkspace from '../../../src/components/improve/ImproveWorkspace.svelte'
  import TaskEditor from '../../../src/components/task/TaskEditor.svelte'
  let { initialTask, mode }: { initialTask: Task; mode: 'workspace' | 'overview' } = $props()
  let task = $state(untrack(() => initialTask))
</script>
{#if mode === 'workspace'}<ImproveWorkspace bind:task />{:else}<TaskEditor bind:task />{/if}
