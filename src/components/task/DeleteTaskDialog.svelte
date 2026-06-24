<script lang="ts">
  import { _ } from 'svelte-i18n'
  import Dialog from '../ui/Dialog.svelte'
  import Button from '../ui/Button.svelte'
  import type { Task } from '../../lib/types'

  let {
    open = $bindable(false),
    task,
    onconfirm,
  }: { open?: boolean; task: Task | null; onconfirm: () => void } = $props()

  let input = $state('')
  $effect(() => {
    if (open) input = ''
  })
</script>

<Dialog bind:open title={$_('task.delete.title')}>
  <p class="muted">{$_('task.delete.body')}</p>
  <p class="prompt">{$_('task.delete.confirmPrompt')}</p>
  <input
    class="confirm-input"
    type="text"
    bind:value={input}
    placeholder={$_('task.delete.confirmPlaceholder')}
  />
  {#snippet actions()}
    <Button variant="ghost" onclick={() => (open = false)}>{$_('common.cancel')}</Button>
    <Button
      variant="danger"
      disabled={input !== (task?.name ?? '')}
      onclick={() => { onconfirm(); open = false }}
    >
      {$_('common.delete')}
    </Button>
  {/snippet}
</Dialog>

<style>
  .muted { color: var(--ink-3); margin-bottom: var(--s-3); }
  .prompt { font-weight: 500; margin-bottom: var(--s-2); }
  .confirm-input {
    width: 100%; height: 38px; padding: 0 var(--s-3);
    background: var(--bg-1); border: 1px solid var(--border-1); border-radius: var(--r-md);
    color: var(--ink-1); font: inherit;
  }
  .confirm-input:focus { outline: none; border-color: var(--err); }
</style>