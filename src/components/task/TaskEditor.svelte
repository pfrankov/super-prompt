<script lang="ts">
  import { _ } from 'svelte-i18n'
  import type { Task } from '../../lib/types'
  import TextField from '../ui/TextField.svelte'
  import TextArea from '../ui/TextArea.svelte'
  import PromptEditor from '../ui/PromptEditor.svelte'
  import Button from '../ui/Button.svelte'
  import Tag from '../ui/Tag.svelte'
  import { saveTask } from '../../lib/db/tasks'
  import { t } from '../../stores/toast'

  let { task = $bindable() as Task }: { task: Task } = $props()
  let saving = $state(false)
  let dirty = $state(false)
  let initial = $state<string>('')

  let newSeed = $state('')

  function snapshot(t: Task) {
    return JSON.stringify({ name: t.name, description: t.description, initialPrompt: t.initialPrompt, seedPrompts: t.seedPrompts, rubric: t.rubric })
  }

  // Take a fresh baseline whenever the task object identity changes (e.g. user
  // navigates to a different task and the parent reuses this component).
  let lastTaskId = $state<string>('')
  $effect(() => {
    if (task.id !== lastTaskId) {
      lastTaskId = task.id
      initial = snapshot(task)
      dirty = false
    } else if (initial) {
      dirty = snapshot(task) !== initial
    }
  })

  $effect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  })

  async function save() {
    saving = true
    try {
      const snap = $state.snapshot(task)
      await saveTask(snap)
      initial = snapshot(snap)
      dirty = false
      t.success($_('actions.saved'))
    } finally {
      saving = false
    }
  }

  function addSeed() {
    if (!newSeed.trim()) return
    task.seedPrompts = [...task.seedPrompts, newSeed.trim()]
    newSeed = ''
  }

  function removeSeed(i: number) {
    task.seedPrompts = task.seedPrompts.filter((_, idx) => idx !== i)
  }
</script>

<div class="form">
  <TextField bind:value={task.name} label={$_('task.name')} placeholder={$_('task.namePlaceholder')} />
  <TextArea
    bind:value={task.description}
    label={$_('task.description')}
    placeholder={$_('task.descriptionPlaceholder')}
    rows={3}
  />
  <PromptEditor bind:value={task.initialPrompt} label={$_('task.initialPrompt')} placeholder={$_('task.initialPromptPlaceholder')} rows={8} />

  <div class="seeds">
    <span class="lbl">{$_('task.seedPrompts')}</span>
    {#each task.seedPrompts as seed, i (i)}
      <div class="seed">
        <span class="seed-text">{seed}</span>
        <button class="x" type="button" onclick={() => removeSeed(i)} aria-label={$_('common.delete')}>
          <svg viewBox="0 0 20 20" width="14" height="14"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>
    {/each}
    <div class="seed-add">
      <input
        type="text"
        bind:value={newSeed}
        placeholder={$_('task.seedPromptPlaceholder')}
        onkeydown={(e) => { if (e.key === 'Enter') addSeed() }}
      />
      <Button size="sm" variant="secondary" onclick={addSeed}>{$_('task.addSeed')}</Button>
    </div>
  </div>

  <TextArea
    bind:value={task.rubric.text}
    label={$_('task.rubric')}
    placeholder={$_('task.rubricPlaceholder')}
    rows={3}
  />

  <div class="row">
    {#if dirty}
      <Tag tone="warn">{$_('common.unsaved')}</Tag>
    {/if}
    <Button onclick={save} loading={saving} disabled={!dirty && !saving}>{$_('common.save')}</Button>
  </div>
</div>

<style>
  .form { display: flex; flex-direction: column; gap: var(--s-4); max-width: 720px; }
  .seeds { display: flex; flex-direction: column; gap: var(--s-2); }
  .lbl { font-size: var(--fs-sm); font-weight: 500; color: var(--ink-2); }
  .seed {
    display: flex; align-items: center; gap: var(--s-2);
    padding: var(--s-2) var(--s-3);
    background: var(--bg-2); border: 1px solid var(--border-1);
    border-radius: var(--r-md); font-size: var(--fs-sm);
  }
  .seed-text { flex: 1; font-family: var(--font-mono); color: var(--ink-2); word-break: break-word; }
  .x { appearance: none; background: transparent; border: none; color: var(--ink-4); cursor: pointer; padding: 4px; border-radius: var(--r-sm); }
  .x:hover { background: rgba(243, 184, 179, 0.1); color: var(--err); }
  .seed-add { display: flex; gap: var(--s-2); }
  .seed-add input {
    flex: 1; height: 32px; padding: 0 var(--s-3);
    background: var(--bg-1); border: 1px solid var(--border-1); border-radius: var(--r-sm);
    color: var(--ink-1); font: inherit; font-size: var(--fs-sm);
  }
  .seed-add input:focus { outline: none; border-color: var(--primary); }
  .row { display: flex; gap: var(--s-2); }
</style>
