<script lang="ts">
  import { tick } from 'svelte'
  import LanguageSwitcher from '../components/chrome/LanguageSwitcher.svelte'
  import { _ } from 'svelte-i18n'
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
  let menuOpen = $state(false)
  let menuElement = $state<HTMLDetailsElement>()
  let menuSummary = $state<HTMLElement>()
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

  async function onTabChange(next: string) {
    menuOpen = false
    tab = next
    navigate(`/task/${taskId}/${next}`)
    await tick()
    document.getElementById('task-panel')?.focus()
  }

  function dismissMenu(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !menuOpen) return
    e.preventDefault()
    menuOpen = false
    menuSummary?.focus()
  }

  function leaveMenu(e: FocusEvent) {
    if (e.relatedTarget instanceof Node && !menuElement?.contains(e.relatedTarget)) menuOpen = false
  }

  function outsideMenu(e: MouseEvent) {
    if (menuOpen && menuElement && e.target instanceof Node && !menuElement.contains(e.target)) menuOpen = false
  }

</script>

<svelte:window onclick={outsideMenu} onkeydown={dismissMenu} />
{#if task}
  {#key refreshKey}
    <header class="task-header">
      <a class="brand" href="#/">{$_('app.title')}</a>
      <h1>{task.name || $_('common.untitled')}</h1>
      <details class="context-menu" bind:open={menuOpen} bind:this={menuElement} onfocusout={leaveMenu}>
        <summary bind:this={menuSummary} aria-label={$_('revision.menu')}>{$_('revision.more')}</summary>
        <div class="menu-content">
          <nav aria-label={$_('revision.taskNavigation')}>
            {#each ['improve', 'overview', 'dataset', 'history'] as value}
              <a href={`#/task/${taskId}/${value}`} aria-current={tab === value ? 'page' : undefined} onclick={(event) => { if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); void onTabChange(value) }}>{$_(`task.tabs.${value}`)}</a>
            {/each}
          </nav>
          <nav class="app-links" aria-label={$_('app.title')}><a href="#/">{$_('nav.tasks')}</a><a href="#/settings">{$_('nav.settings')}</a></nav>
          <LanguageSwitcher />
          <Button variant="ghost" size="sm" disabled={!!$activeRunId && $optimizationState.run?.taskId === task.id} onclick={() => { menuOpen = false; menuSummary?.focus(); deleteOpen = true }}>{$_('common.delete')}</Button>
        </div>
      </details>
    </header>
    <div class="tab-pane" id="task-panel" tabindex="-1" aria-busy={false}>
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
  .task-header { display:flex; align-items:center; gap:24px; min-height:48px; padding-bottom:20px; border-bottom:1px solid var(--border-1); }
  .brand { color:var(--ink-1); font-size:19px; font-weight:650; letter-spacing:-.025em; white-space:nowrap; }.brand:hover { text-decoration:none; }
  h1 { font-size:14px; color:var(--ink-2); font-weight:400; border-left:1px solid var(--border-2); padding-left:24px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1.5; min-width:0; }
  .context-menu { position:relative; margin-left:auto; flex-shrink:0; }.context-menu summary { cursor:pointer; min-height:44px; display:flex; align-items:center; padding:0 12px; color:var(--ink-2); font-size:13px; list-style:revert; }
  .menu-content { position:absolute; top:calc(100% + 8px); right:0; z-index:var(--z-dropdown); width:230px; max-width:calc(100vw - 40px); max-height:calc(100dvh - 120px); overflow:auto; overscroll-behavior:contain; background:var(--bg-0); border:1px solid var(--border-2); border-radius:8px; box-shadow:var(--shadow-2); padding:10px; display:grid; gap:8px; }
  nav { display:grid; }nav a { min-height:40px; padding:9px 12px; color:var(--ink-2); font-size:13px; border-radius:4px; }nav a:hover,nav a[aria-current] { background:var(--bg-2); color:var(--ink-1); text-decoration:none; }.app-links { border-top:1px solid var(--border-1); padding-top:8px; }
  .tab-pane { margin-top:24px; }.muted { color:var(--ink-3); padding:var(--s-8); }
  @media(max-width:600px) { .task-header { gap:12px; flex-wrap:wrap; padding-bottom:12px; }.brand { font-size:17px; }h1 { order:3; flex-basis:100%; border:0; padding:0; font-size:12px; }.context-menu { margin-left:auto; }.tab-pane { margin-top:16px; } }
</style>
