<script lang="ts">
  import { get } from 'svelte/store'
  import { _ } from 'svelte-i18n'
  import Dialog from '../ui/Dialog.svelte'
  import TextField from '../ui/TextField.svelte'
  import Button from '../ui/Button.svelte'
  import { settings, saveSettings } from '../../stores/settings'
  import { defaultProvider, defaultArbitrator } from '../../lib/db/settings'
  import { MOCK_PROVIDER_URL, MOCK_TARGET_MODEL, MOCK_JUDGE_MODEL } from '../../lib/api/mockOpenai'
  import { isRunnableProvider } from '../../lib/improve/model-routing'

  let { open = $bindable(false) }: { open?: boolean } = $props()
  let provider = $state(defaultProvider())
  let arbitrator = $state(defaultArbitrator())
  let saving = $state(false)
  let error = $state('')
  $effect(() => {
    if (open) {
      const current = get(settings)
      provider = structuredClone(current.provider)
      arbitrator = structuredClone(current.arbitrator)
      error = ''
    }
  })
  function demo() {
    provider = { ...provider, label: 'Demo provider', baseUrl: MOCK_PROVIDER_URL, apiKey: '', targetModel: MOCK_TARGET_MODEL, judgeModel: MOCK_JUDGE_MODEL, maxRetries: 0 }
    arbitrator.enabled = false
  }
  const valid = $derived(isRunnableProvider(provider) && !!provider.targetModel.trim() && !!provider.judgeModel.trim()
    && (!arbitrator.enabled || (!!arbitrator.baseUrl.trim() && !!arbitrator.model.trim() && isRunnableProvider(arbitrator))))
  async function save() {
    if (!valid || saving) return
    saving = true
    try {
      await saveSettings({ provider: $state.snapshot(provider), arbitrator: $state.snapshot(arbitrator) })
      open = false
    } catch (e) { error = e instanceof Error ? e.message : String(e) }
    finally { saving = false }
  }
</script>

<Dialog bind:open title={$_('workspace.modelsTitle')} maxWidth="760px">
  <p class="intro">{$_('workspace.modelsIntro')}</p>
  <div class="demo"><span>{$_('workspace.demoHelp')}</span><Button size="sm" variant="secondary" onclick={demo}>{$_('settings.useDemo')}</Button></div>
  <div class="model-config">
    <section>
      <h4>{$_('workspace.targetRole')}</h4>
      <p>{$_('workspace.targetHelp')}</p>
      <TextField bind:value={provider.baseUrl} label={$_('settings.baseUrl')} />
      <TextField bind:value={provider.apiKey} label={$_('settings.apiKey')} type="password" />
      <TextField bind:value={provider.targetModel} label={$_('settings.targetModel')} />
    </section>
    <section>
      <h4>{$_('workspace.arbiterRole')}</h4>
      <p>{$_('workspace.arbiterHelp')}</p>
      <TextField bind:value={provider.judgeModel} label={$_('settings.judgeModel')} />
      <label class="toggle"><input type="checkbox" bind:checked={arbitrator.enabled} />{$_('workspace.separateArbiter')}</label>
      {#if arbitrator.enabled}
        <TextField bind:value={arbitrator.baseUrl} label={$_('workspace.arbiterUrl')} />
        <TextField bind:value={arbitrator.apiKey} label={$_('workspace.arbiterKey')} type="password" />
        <TextField bind:value={arbitrator.model} label={$_('workspace.arbiterModel')} />
      {/if}
    </section>
  </div>
  <p class="privacy">{$_('workspace.keyStorage')}</p>
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#snippet actions()}
    <Button variant="ghost" onclick={() => open = false}>{$_('common.cancel')}</Button>
    <Button onclick={save} loading={saving} disabled={!valid}>{$_('workspace.saveModels')}</Button>
  {/snippet}
</Dialog>

<style>
  .intro,.privacy { color:var(--ink-2); font-size:var(--fs-sm); margin:var(--s-3) 0; }
  .demo { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px; background:var(--bg-1); border:1px solid var(--border-1); border-radius:var(--r-md); font-size:var(--fs-sm); }
  .model-config { display:grid; grid-template-columns:1fr 1fr; gap:24px; margin-top:24px; }
  section { min-width:0; display:flex; flex-direction:column; gap:12px; }
  section p { margin:0; color:var(--ink-2); font-size:var(--fs-sm); }
  .toggle { display:flex; align-items:center; gap:8px; min-height:44px; font-size:var(--fs-sm); }
  .error { color:var(--err); }
  @media(max-width:600px) { .model-config { grid-template-columns:1fr; } .demo { align-items:flex-start; flex-direction:column; } }
</style>
