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
  import { getTask } from '../lib/db/tasks'
  import type { Task } from '../lib/types'
  import { navigate } from '../stores/router'
  import { t } from '../stores/toast'
  import { deleteTask } from '../lib/db/tasks'
  import { activeRunId, optimizationState } from '../stores/worker'

  let { taskId, initialTab = 'improve' }: { taskId: string; initialTab?: string } = $props()

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

  $effect(() => { taskId; load() })

  async function onDelete() {
    if (!task || $activeRunId && $optimizationState.run?.taskId === task.id) return
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
    <div class="task-chrome">
      <TopBar
        title={task.name || $_('common.untitled')}
        compact
      >
        <Button variant="ghost" size="sm" disabled={!!$activeRunId && $optimizationState.run?.taskId === task.id} onclick={() => (deleteOpen = true)}>{$_('common.delete')}</Button>
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
    </div>

    <div class="tab-pane" role="tabpanel" id="task-panel" aria-labelledby={`tab-${tab}`} tabindex="0" aria-busy={false}>
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
  .task-chrome { display:flex; align-items:center; justify-content:space-between; gap:24px; }
  .task-chrome :global(.bar.compact) { margin:0; flex:1; min-width:0; }
  .task-chrome :global(.tabs) { gap: 24px; padding: 0; }
  .task-chrome :global(.tab) { padding: 10px 0; font-size: var(--fs-sm); border-radius: 0; }
  .task-chrome :global(.tab:hover) { background: transparent; color: var(--ink-1); }
  .tab-pane { margin-top: 24px; }
  .muted { color: var(--ink-3); padding: var(--s-8); }
  @media (max-width: 800px) {
    .task-chrome { display:block; }
    .task-chrome :global(.bar.compact) { margin-bottom:12px; }
    .task-chrome :global(.tabs) { gap: 22px; }
    .tab-pane { margin-top: 24px; }
  }
</style>
