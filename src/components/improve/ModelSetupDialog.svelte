<script lang="ts">
  import { get } from 'svelte/store'
  import { _ } from 'svelte-i18n'
  import Dialog from '../ui/Dialog.svelte'
  import TextField from '../ui/TextField.svelte'
  import Button from '../ui/Button.svelte'
  import { settings, saveSettings, waitForSettings } from '../../stores/settings'
  import { defaultProvider, defaultArbitrator } from '../../lib/db/settings'
  import { MOCK_PROVIDER_URL, MOCK_TARGET_MODEL, MOCK_JUDGE_MODEL } from '../../lib/api/mockOpenai'
  import { isRunnableModelSetup } from '../../lib/improve/model-routing'

  let { open = $bindable(false) }: { open?: boolean } = $props()
  let provider = $state(defaultProvider())
  let arbitrator = $state(defaultArbitrator())
  let saving = $state(false)
  let loading = $state(false)
  let error = $state('')
  let dialogSession = 0
  $effect(() => {
    const session = ++dialogSession
    saving = false
    if (!open) { loading = false; return }
    loading = true
    error = ''
    // Navigation can flush a settings draft immediately before this opens.
    // Do not expose an editable snapshot until all preceding writes settle.
    void waitForSettings().then(() => {
      if (session !== dialogSession) return
      const current = get(settings)
      provider = structuredClone(current.provider)
      arbitrator = structuredClone(current.arbitrator)
      loading = false
    })
    return () => { dialogSession += 1 }
  })
  function demo() {
    provider = { ...provider, label: 'Demo provider', baseUrl: MOCK_PROVIDER_URL, apiKey: '', targetModel: MOCK_TARGET_MODEL, judgeModel: MOCK_JUDGE_MODEL, maxRetries: 0 }
    arbitrator.enabled = false
  }
  const valid = $derived(isRunnableModelSetup(provider, arbitrator))
  async function save() {
    if (!valid || saving || loading) return
    const session = dialogSession
    saving = true
    try {
      await saveSettings({ provider: $state.snapshot(provider), arbitrator: $state.snapshot(arbitrator) })
      if (session === dialogSession) open = false
    } catch (e) { if (session === dialogSession) error = e instanceof Error ? e.message : String(e) }
    finally { if (session === dialogSession) saving = false }
  }
</script>

<Dialog bind:open title={$_('workspace.modelsTitle')} maxWidth="760px">
  <p class="intro">{$_('workspace.modelsIntro')}</p>
  {#if loading}
    <p role="status">{$_('common.loading')}</p>
  {:else}
  <div class="demo"><span>{$_('workspace.demoHelp')}</span><Button size="sm" variant="secondary" onclick={demo} disabled={saving}>{$_('settings.useDemo')}</Button></div>
  <div class="model-config">
    <section>
      <h4>{$_('workspace.targetRole')}</h4>
      <p>{$_('workspace.targetHelp')}</p>
      <TextField bind:value={provider.baseUrl} label={$_('settings.baseUrl')} disabled={saving} />
      <TextField bind:value={provider.apiKey} label={$_('settings.apiKey')} type="password" disabled={saving} />
      <TextField bind:value={provider.targetModel} label={$_('settings.targetModel')} disabled={saving} />
    </section>
    <section>
      <h4>{$_('workspace.arbiterRole')}</h4>
      <p>{$_('workspace.arbiterHelp')}</p>
      {#if !arbitrator.enabled}<TextField bind:value={provider.judgeModel} label={$_('settings.judgeModel')} disabled={saving} />{/if}
      <label class="toggle"><input type="checkbox" bind:checked={arbitrator.enabled} disabled={saving} />{$_('workspace.separateArbiter')}</label>
      {#if arbitrator.enabled}
        <TextField bind:value={arbitrator.baseUrl} label={$_('workspace.arbiterUrl')} disabled={saving} />
        <TextField bind:value={arbitrator.apiKey} label={$_('workspace.arbiterKey')} type="password" disabled={saving} />
        <TextField bind:value={arbitrator.model} label={$_('workspace.arbiterModel')} disabled={saving} />
      {/if}
    </section>
  </div>
  {/if}
  <p class="privacy">{$_('workspace.keyStorage')}</p>
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#snippet actions()}
    <Button variant="ghost" onclick={() => open = false}>{$_('common.cancel')}</Button>
    <Button onclick={save} loading={saving} disabled={!valid || loading}>{$_('workspace.saveModels')}</Button>
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
