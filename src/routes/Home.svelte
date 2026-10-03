<script lang="ts">
  import { _ } from 'svelte-i18n'
  import TopBar from '../components/chrome/TopBar.svelte'
  import Button from '../components/ui/Button.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import DeleteTaskDialog from '../components/task/DeleteTaskDialog.svelte'
  import { onMount } from 'svelte'
  import { listTasks, deleteTask } from '../lib/db/tasks'
  import type { Task } from '../lib/types'
  import { navigate } from '../stores/router'
  import { t } from '../stores/toast'
  import { activeRunId, optimizationState } from '../stores/worker'

  let { onCreateTask }: { onCreateTask?: () => void } = $props()

  let tasks: Task[] = $state([])
  let loading = $state(true)
  let deleteTarget: Task | null = $state(null)
  let deleteOpen = $state(false)

  async function reload() {
    loading = true
    tasks = await listTasks()
    loading = false
  }

  onMount(reload)

  function onDeleteClick(task: Task) {
    deleteTarget = task
    deleteOpen = true
  }

  async function onDeleteConfirm() {
    if (!deleteTarget || $activeRunId && $optimizationState.run?.taskId === deleteTarget.id) return
    const id = deleteTarget.id
    deleteOpen = false
    deleteTarget = null
    await deleteTask(id)
    await reload()
    t.success($_('toast.deleted'))
  }
</script>

<div class="home">
  <TopBar title={$_('home.title')} subtitle={$_('home.subtitle')}>
    {#if tasks.length > 0}
      <Button onclick={onCreateTask}>{$_('home.newTask')}</Button>
    {/if}
  </TopBar>

  {#if loading}
    <div class="loading-list" aria-busy="true" aria-label={$_('common.loading')}>
      {#each [0, 1, 2] as i (i)}
        <div class="loading-row">
          <Skeleton width="220px" height="19px" />
          <Skeleton width="min(440px, 85%)" height="14px" />
        </div>
      {/each}
    </div>
  {:else if tasks.length === 0}
    <section class="empty">
      <h2>{$_('home.emptyTitle')}</h2>
      <p>{$_('home.emptyBody')}</p>
      <Button size="lg" onclick={onCreateTask}>{$_('home.newTask')}</Button>
    </section>
  {:else}
    <ul class="prompt-list" aria-label={$_('home.title')}>
      {#each tasks as task (task.id)}
        <li class="prompt-row">
          <button
            class="prompt-open"
            type="button"
            aria-labelledby={`prompt-title-${task.id}`}
            aria-describedby={`prompt-description-${task.id}`}
            onclick={() => navigate(`/task/${task.id}/improve`)}
          >
            <span class="prompt-info">
              <span class="prompt-title" id={`prompt-title-${task.id}`}>{task.name || $_('common.untitled')}</span>
              <span class="description" id={`prompt-description-${task.id}`}>{(task.description || task.initialPrompt || $_('home.noDescription')).slice(0, 180)}</span>
            </span>
            <span class="metadata">
              <span class="example-state">{task.datasetId ? $_('task.tabs.dataset') : $_('dataset.emptyTitle')}</span>
              <time class="updated numeric" datetime={new Date(task.updatedAt).toISOString()}>{new Date(task.updatedAt).toLocaleDateString()}</time>
            </span>
          </button>
          <button
            class="delete"
            type="button"
            disabled={!!$activeRunId && $optimizationState.run?.taskId === task.id}
            onclick={() => onDeleteClick(task)}
            aria-label={$_('common.delete')}
            title={`${$_('common.delete')}: ${task.name || $_('common.untitled')}`}
          >{$_('common.delete')}</button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<DeleteTaskDialog bind:open={deleteOpen} task={deleteTarget} onconfirm={onDeleteConfirm} />

<style>
  .home { padding-top: 8px; }
  .empty {
    max-width: 620px;
    margin: 0 auto;
    padding: 96px 0 120px;
    text-align: center;
  }
  .empty h2 { font-size: 28px; font-weight: 550; letter-spacing: -0.025em; }
  .empty p { color: var(--ink-3); margin: 18px auto 28px; max-width: 43ch; line-height: 1.7; }
  .prompt-list { list-style: none; margin: 0; padding: 0; }
  .prompt-row { display: flex; align-items: center; gap: 20px; border-bottom: 1px solid var(--border-1); }
  .prompt-open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 32px;
    padding: 24px 4px;
    text-align: left;
    border-radius: 4px;
  }
  .prompt-open:hover .prompt-title { text-decoration: underline; text-underline-offset: 4px; }
  .prompt-info { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
  .prompt-title { font-size: var(--fs-lg); font-weight: 500; line-height: 1.4; overflow-wrap: anywhere; }
  .description {
    display: -webkit-box;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
    color: var(--ink-3);
    font-size: var(--fs-sm);
    line-height: 1.5;
  }
  .metadata { display: flex; flex-shrink: 0; align-items: center; gap: 28px; color: var(--ink-3); font-size: var(--fs-xs); }
  .updated { min-width: 78px; text-align: right; }
  .delete { align-self: center; min-height: 44px; color: var(--ink-3); padding: 8px; font-size: var(--fs-xs); border-radius: 4px; }
  .delete:hover:not(:disabled) { color: var(--err); background: var(--bg-1); }
  .delete:disabled { opacity: 0.4; cursor: not-allowed; }
  .loading-row { display: flex; flex-direction: column; gap: 14px; padding: 25px 4px; border-bottom: 1px solid var(--border-1); }
  @media (max-width: 720px) {
    .prompt-row { gap: 12px; }
    .prompt-open { align-items: flex-start; flex-direction: column; gap: 14px; padding: 20px 0; }
    .prompt-title { font-size: var(--fs-md); }
    .metadata { gap: 20px; }
    .updated { min-width: 0; text-align: left; }
    .description { -webkit-line-clamp: 2; line-clamp: 2; }
    .empty { padding: 64px 0 88px; }
    .empty h2 { font-size: 25px; }
  }
</style>
