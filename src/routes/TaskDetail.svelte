<script lang="ts">
  import { _ } from 'svelte-i18n'
  import TopBar from '../components/chrome/TopBar.svelte'
  import Tabs from '../components/ui/Tabs.svelte'
  import Button from '../components/ui/Button.svelte'
  import DeleteTaskDialog from '../components/task/DeleteTaskDialog.svelte'
  import TaskOverviewTab from '../components/task/TaskOverviewTab.svelte'
  import DatasetTab from '../components/dataset/DatasetTab.svelte'
  import HistoryTab from '../components/task/HistoryTab.svelte'
  import ImproveWorkspace from '../components/improve/ImproveWorkspace.svelte'
  import { onMount } from 'svelte'
  import { getTask } from '../lib/db/tasks'
  import type { Task } from '../lib/types'
  import { navigate } from '../stores/router'
  import { t } from '../stores/toast'
  import { deleteTask } from '../lib/db/tasks'

  let { taskId, initialTab = 'overview' }: { taskId: string; initialTab?: string } = $props()

  let task: Task | null = $state(null)
  let tab = $state('improve')
  let deleteOpen = $state(false)
  let refreshKey = $state(0)
  const validTabs = ['improve', 'overview', 'dataset', 'optimize', 'history']

  $effect(() => {
    const next = initialTab && validTabs.includes(initialTab) ? initialTab : 'improve'
    tab = next === 'optimize' ? 'improve' : next
  })

  async function load() {
    const found = await getTask(taskId)
    if (!found) {
      navigate('/')
      return
    }
    task = found
  }

  onMount(load)
  $effect(() => { taskId; load() })

  async function onDelete() {
    if (!task) return
    const id = task.id
    await deleteTask(id)
    t.success($_('toast.deleted'))
    navigate('/')
  }

  function onTabChange(next: string) {
    tab = next
    navigate(`/task/${taskId}/${next}`)
  }
</script>

{#if task}
  {#key refreshKey}
    <TopBar
      title={task.name || $_('common.untitled')}
      subtitle={task.description}
    >
      <Button variant="danger" size="sm" onclick={() => (deleteOpen = true)}>{$_('common.delete')}</Button>
    </TopBar>

    <Tabs
      tabs={[
        { value: 'improve', label: $_('task.tabs.improve') },
        { value: 'overview', label: $_('task.tabs.overview') },
        { value: 'dataset', label: $_('task.tabs.dataset') },
        { value: 'history', label: $_('task.tabs.history') },
      ]}
      bind:active={tab}
      onchange={onTabChange}
    />

    <div class="tab-pane" aria-busy={false}>
      {#if tab === 'improve'}
        <ImproveWorkspace bind:task={task as Task} />
      {:else if tab === 'overview'}
        <TaskOverviewTab bind:task={task as Task} />
      {:else if tab === 'dataset'}
        <DatasetTab bind:task={task as Task} />
      {:else if tab === 'history'}
        <HistoryTab task={task as Task} />
      {/if}
    </div>
  {/key}

  <DeleteTaskDialog bind:open={deleteOpen} {task} onconfirm={onDelete} />
{:else}
  <div class="muted" aria-busy="true">{$_('common.loading')}</div>
{/if}

<style>
  .tab-pane { margin-top: var(--s-4); }
  .muted { color: var(--ink-3); padding: var(--s-8); }
</style>
