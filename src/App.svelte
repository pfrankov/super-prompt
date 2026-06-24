<script lang="ts">
  import AppShell from './components/chrome/AppShell.svelte'
  import { route, navigate } from './stores/router'
  import Home from './routes/Home.svelte'
  import Settings from './routes/Settings.svelte'
  import NotFound from './routes/NotFound.svelte'
  import { createTask } from './lib/db/tasks'
  import { t } from './stores/toast'
  import { _ } from 'svelte-i18n'

  // Placeholder TaskDetail — filled in Phase C/E
  import TaskDetail from './routes/TaskDetail.svelte'

  async function onCreateTask() {
    const task = await createTask({ name: '' })
    navigate(`/task/${task.id}/improve`)
    t.success($_('toast.saved'))
  }
</script>

<AppShell {onCreateTask}>
  {#if $route.name === 'home'}
    <Home {onCreateTask} />
  {:else if $route.name === 'task'}
    {#key $route.id}
      <TaskDetail taskId={$route.id} initialTab={$route.tab ?? 'overview'} />
    {/key}
  {:else if $route.name === 'settings'}
    <Settings />
  {:else}
    <NotFound />
  {/if}
</AppShell>
