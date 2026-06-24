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
  import Tag from '../components/ui/Tag.svelte'

  let { onCreateTask }: { onCreateTask?: () => void } = $props()

  let tasks: Task[] = $state([])
  let loading = $state(true)
  let deleteTarget: Task | null = $state(null)
  let deleteOpen = $state(false)

  $effect(() => {
    if (deleteTarget) deleteOpen = true
  })

  async function reload() {
    loading = true
    tasks = await listTasks()
    loading = false
  }

  onMount(reload)

  function onDeleteClick(task: Task, e: MouseEvent) {
    e.stopPropagation()
    deleteTarget = task
  }

  function onDeleteKey(task: Task, e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation()
      e.preventDefault()
      deleteTarget = task
    }
  }

  async function onDeleteConfirm() {
    if (!deleteTarget) return
    const id = deleteTarget.id
    deleteOpen = false
    deleteTarget = null
    await deleteTask(id)
    await reload()
    t.success($_('toast.deleted'))
  }
</script>

<TopBar
  title={$_('home.title')}
  subtitle={$_('home.subtitle')}
>
  <Button onclick={onCreateTask}>
    {$_('home.newTask')}
  </Button>
</TopBar>

{#if loading}
  <div class="grid" aria-busy="true" aria-label={$_('common.loading')}>
    {#each [0, 1, 2, 3] as i (i)}
      <div class="card surface">
        <Skeleton width="60%" height="20px" />
        <Skeleton width="90%" height="14px" />
        <div class="meta">
          <Skeleton width="80px" height="20px" />
        </div>
      </div>
    {/each}
  </div>
{:else if tasks.length === 0}
  <div class="empty surface">
    <div class="empty-illu" aria-hidden="true">
      <svg viewBox="0 0 64 64" width="64" height="64">
        <rect x="6" y="14" width="52" height="36" rx="4" fill="var(--bg-2)" stroke="var(--border-2)" stroke-width="1"/>
        <path d="M14 22h28M14 28h36M14 34h22M14 40h14" stroke="var(--ink-3)" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="50" cy="40" r="10" fill="var(--bg-3)" stroke="var(--primary)" stroke-width="1.5"/>
        <path d="M50 36v8M46 40h8" stroke="var(--primary)" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </div>
    <h2>{$_('home.emptyTitle')}</h2>
    <p class="muted">{$_('home.emptyBody')}</p>
    <Button onclick={onCreateTask}>{$_('home.newTask')}</Button>
  </div>
{:else}
  <div class="grid">
    {#each tasks as task (task.id)}
      <div class="card surface" role="button" tabindex="0" onclick={() => navigate(`/task/${task.id}`)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/task/${task.id}`) } }}>
        <div class="card-head">
          <h3 class="card-title">{task.name || $_('common.untitled')}</h3>
          <button class="del" type="button" onclick={(e) => onDeleteClick(task, e)} onkeydown={(e) => onDeleteKey(task, e)} aria-label={$_('common.delete')}>
            <svg viewBox="0 0 20 20" width="14" height="14"><path d="M5 6h10M8 6V4h4v2M7 6l1 10h4l1-10" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <p class="desc">{task.description || $_('home.noDescription')}</p>
        <div class="meta">
          {#if task.datasetId}
            <Tag tone="ok">{$_('task.tabs.dataset')}</Tag>
          {:else}
            <Tag tone="warn">{$_('dataset.emptyTitle')}</Tag>
          {/if}
          <span class="updated dim numeric">{new Date(task.updatedAt).toLocaleDateString()}</span>
        </div>
      </div>
    {/each}
  </div>
{/if}

<DeleteTaskDialog bind:open={deleteOpen} task={deleteTarget} onconfirm={onDeleteConfirm} />

<style>
  .empty {
    padding: var(--s-12) var(--s-8);
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-3);
  }
  .empty-illu { color: var(--ink-3); margin-bottom: var(--s-2); }
  .empty h2 { font-size: var(--fs-2xl); }
  .muted { color: var(--ink-3); max-width: 36ch; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--s-4);
  }
  .card {
    position: relative;
    text-align: left;
    padding: var(--s-4) var(--s-5);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    transition: border-color var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease), box-shadow var(--dur-base) var(--ease);
  }
  .card:hover { border-color: var(--border-2); transform: translateY(-1px); box-shadow: var(--shadow-2); }
  .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s-2); }
  .card-title { margin: 0; font-size: var(--fs-lg); line-height: 1.3; }
  .desc { color: var(--ink-2); font-size: var(--fs-sm); margin: 0; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .meta { display: flex; align-items: center; justify-content: space-between; margin-top: var(--s-2); }
  .updated { font-size: var(--fs-xs); }
  .del {
    appearance: none; background: transparent; border: none; padding: 4px;
    color: var(--ink-4); border-radius: var(--r-sm); cursor: pointer;
    transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }
  .del:hover { background: rgba(243, 184, 179, 0.1); color: var(--err); }
</style>
