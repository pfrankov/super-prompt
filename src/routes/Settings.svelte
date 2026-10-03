<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { onDestroy, untrack } from 'svelte'
  import { get } from 'svelte/store'
  import TopBar from '../components/chrome/TopBar.svelte'
  import TextField from '../components/ui/TextField.svelte'
  import NumberField from '../components/ui/NumberField.svelte'
  import Button from '../components/ui/Button.svelte'
  import Tag from '../components/ui/Tag.svelte'
  import Dialog from '../components/ui/Dialog.svelte'
  import { settings, saveSettings, setLang } from '../stores/settings'
  import { wipeAll } from '../lib/db/db'
  import { activeRunId } from '../stores/worker'
  import { t } from '../stores/toast'
  import { listProviderModels, selectJudgeModel } from '../lib/improve/model-routing'
  import { MOCK_JUDGE_MODEL, MOCK_PROVIDER_URL, MOCK_TARGET_MODEL } from '../lib/api/mockOpenai'
  import { newId } from '../lib/util/id'
  import type { AppSettings, Lang, ModelRateLimitRule, ProviderConfig, ArbitratorConfig } from '../lib/types'

  let testing = $state(false)
  let testResult: 'ok' | 'fail' | null = $state(null)
  let detectingOllama = $state(false)
  let ollamaMessage = $state('')
  let ollamaOk = $state(false)

  let showKey = $state(false)
  let showArbKey = $state(false)
  let wipeOpen = $state(false)
  let wipeConfirm = $state('')
  let savedAt = $state<number | null>(null)

  let draft = $state<AppSettings>(structuredClone(get(settings)))
  let observedDraft = structuredClone(get(settings))
  const providerEdits = new Set<keyof ProviderConfig>()
  const arbitratorEdits = new Set<keyof ArbitratorConfig>()
  let saveError = $state('')
  let languageError = $state('')
  let changingLanguage = $state(false)
  let dirty = $state(false)
  let saving = $state(0)
  let editRevision = 0
  let saveTimer: number | undefined

  function editedFields<T extends object>(current: T, previous: T, edits: Set<keyof T>) {
    for (const key of Object.keys(current) as (keyof T)[]) {
      if (JSON.stringify(current[key]) !== JSON.stringify(previous[key])) edits.add(key)
    }
  }

  function modelPatch<T extends object>(current: T, edits: Set<keyof T>): Partial<T> {
    return Object.fromEntries([...edits].map((key) => [key, current[key]])) as Partial<T>
  }

  // A save from the previous page can finish after this form mounts. Refresh
  // untouched fields while preserving every explicit edit, including reverts.
  $effect(() => {
    const committed = $settings
    untrack(() => {
      draft.provider = { ...structuredClone(committed.provider), ...modelPatch($state.snapshot(draft.provider), providerEdits) }
      draft.arbitrator = { ...structuredClone(committed.arbitrator), ...modelPatch($state.snapshot(draft.arbitrator), arbitratorEdits) }
      observedDraft = $state.snapshot(draft)
    })
  })

  function markEdited() {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = undefined
    editRevision += 1
    dirty = true
    savedAt = null
    saveError = ''
    ollamaMessage = ''
    testResult = null
    editedFields(draft.provider, observedDraft.provider, providerEdits)
    editedFields(draft.arbitrator, observedDraft.arbitrator, arbitratorEdits)
    observedDraft = $state.snapshot(draft)
  }

  async function persistDraft(): Promise<boolean> {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = undefined
    const revision = editRevision
    const patch = $state.snapshot({
      provider: modelPatch(draft.provider, providerEdits),
      arbitrator: modelPatch(draft.arbitrator, arbitratorEdits),
    })
    saving += 1
    try {
      await saveSettings(patch)
      if (revision === editRevision) {
        providerEdits.clear()
        arbitratorEdits.clear()
        dirty = false
        saveError = ''
        savedAt = Date.now()
      }
      return revision === editRevision
    } catch {
      if (revision === editRevision) saveError = `${$_('common.unsaved')}. ${$_('toast.error')}`
      t.error($_('toast.error'))
      return false
    } finally { saving -= 1 }
  }

  // Preserve the last edit even when navigation happens before the debounce.
  onDestroy(() => { if (saveTimer !== undefined) void persistDraft() })

  async function changeLanguage(lang: Lang) {
    if (changingLanguage) return
    changingLanguage = true
    languageError = ''
    try { await setLang(lang) }
    catch {
      languageError = $_('toast.error')
      t.error(languageError)
    } finally { changingLanguage = false }
  }

  function isLocalProvider(baseUrl: string) {
    try {
      const host = new URL(baseUrl).hostname
      return host === 'localhost' || host === '127.0.0.1' || host === '::1'
    } catch {
      return false
    }
  }

  function isMockProvider(baseUrl: string) {
    return baseUrl.trim().toLowerCase().startsWith('mock://')
  }

  function isKeylessProvider(baseUrl: string) {
    return isLocalProvider(baseUrl) || isMockProvider(baseUrl)
  }

  function validBaseUrl(value: string) {
    return value.startsWith('http://') || value.startsWith('https://') || value.startsWith('mock://')
  }

  function pickOllamaModel(models: string[]) {
    const chatModels = models.filter((m) => !/(embed|embedding|bge|nomic|all-minilm)/i.test(m))
    const ranked = [
      (m: string) => /gemma/i.test(m),
      (m: string) => /(llama|mistral|phi)/i.test(m),
      (m: string) => /qwen/i.test(m),
      () => true,
    ]
    for (const match of ranked) {
      const found = chatModels.find(match)
      if (found) return found
    }
    return ''
  }

  function scheduleSave() {
    markEdited()
    saveTimer = window.setTimeout(() => { void persistDraft() }, 500)
  }

  function rateLimits(): ModelRateLimitRule[] {
    return draft.provider.modelRateLimits ?? []
  }

  function setRateLimits(rules: ModelRateLimitRule[]) {
    draft.provider.modelRateLimits = rules
    scheduleSave()
  }

  function updateRateLimit(id: string, patch: Partial<ModelRateLimitRule>) {
    setRateLimits(rateLimits().map((rule) => rule.id === id ? { ...rule, ...patch } : rule))
  }

  function addRateLimit(model = '') {
    const trimmedModel = model.trim()
    setRateLimits([
      ...rateLimits(),
      {
        id: newId(),
        enabled: true,
        model: trimmedModel,
        requestsPerMinute: 30,
      },
    ])
  }

  function addCurrentModelLimits() {
    const current = [
      draft.provider.targetModel,
      draft.provider.judgeModel,
      draft.arbitrator.enabled ? draft.arbitrator.model : '',
    ].map((model) => model.trim()).filter(Boolean)
    const existing = new Set(rateLimits().map((rule) => rule.model.trim().toLowerCase()).filter(Boolean))
    const next = [...rateLimits()]
    for (const model of current) {
      const key = model.toLowerCase()
      if (existing.has(key)) continue
      existing.add(key)
      next.push({
        id: newId(),
        enabled: true,
        model,
        requestsPerMinute: 30,
      })
    }
    if (next.length === rateLimits().length) addRateLimit()
    else setRateLimits(next)
  }

  function removeRateLimit(id: string) {
    setRateLimits(rateLimits().filter((rule) => rule.id !== id))
  }

  async function testConnection() {
    testing = true
    testResult = null
    const useArbitrator = draft.arbitrator?.enabled && draft.arbitrator.baseUrl.trim()
    const baseUrl = (useArbitrator ? draft.arbitrator!.baseUrl : draft.provider.baseUrl).replace(/\/$/, '')
    const apiKey = useArbitrator ? draft.arbitrator!.apiKey : draft.provider.apiKey
    try {
      await listProviderModels({ baseUrl, apiKey })
      testResult = 'ok'
    } catch {
      testResult = 'fail'
    } finally {
      testing = false
    }
  }

  async function useLocalOllama() {
    const startedRevision = editRevision
    detectingOllama = true
    ollamaMessage = ''
    ollamaOk = false
    try {
      const baseUrl = 'http://127.0.0.1:11434/v1'
      const r = await fetch(baseUrl + '/models')
      if (!r.ok) throw new Error('models_failed')
      const json = await r.json() as { data?: Array<{ id?: string }> }
      const models = (json.data ?? []).map((m) => m.id).filter((m): m is string => !!m)
      const model = pickOllamaModel(models)
      if (!model) throw new Error('no_chat_models')
      const judge = selectJudgeModel(models, model, 'local')
      if (startedRevision !== editRevision) return
      draft = {
        ...draft,
        provider: {
          ...draft.provider,
          label: 'Local Ollama',
          baseUrl,
          apiKey: '',
          targetModel: model,
          judgeModel: judge.model,
          requestTimeoutMs: 180_000,
          maxRetries: 1,
        },
        arbitrator: {
          ...draft.arbitrator,
          enabled: false,
        },
      }
      for (const key of ['label', 'baseUrl', 'apiKey', 'targetModel', 'judgeModel', 'requestTimeoutMs', 'maxRetries'] as const) providerEdits.add(key)
      arbitratorEdits.add('enabled')
      markEdited()
      if (!await persistDraft()) return
      savedAt = Date.now()
      testResult = 'ok'
      ollamaOk = true
      ollamaMessage = $_('settings.ollamaPicked', { values: { model } })
    } catch {
      testResult = 'fail'
      ollamaMessage = $_('settings.ollamaFailed')
      t.error($_('settings.ollamaFailed'))
    } finally {
      detectingOllama = false
    }
  }

  async function useDemoProvider() {
    draft = {
      ...draft,
      provider: {
        ...draft.provider,
        label: 'Demo provider',
        baseUrl: MOCK_PROVIDER_URL,
        apiKey: '',
        targetModel: MOCK_TARGET_MODEL,
        judgeModel: MOCK_JUDGE_MODEL,
        requestTimeoutMs: 10_000,
        maxRetries: 0,
      },
      arbitrator: {
        ...draft.arbitrator,
        enabled: false,
      },
    }
    for (const key of ['label', 'baseUrl', 'apiKey', 'targetModel', 'judgeModel', 'requestTimeoutMs', 'maxRetries'] as const) providerEdits.add(key)
    arbitratorEdits.add('enabled')
    markEdited()
    if (!await persistDraft()) return
    savedAt = Date.now()
    testResult = 'ok'
    ollamaOk = true
    ollamaMessage = $_('settings.demoPicked')
  }

  async function useTargetForJudge() {
    draft.provider.judgeModel = draft.provider.targetModel
    providerEdits.add('judgeModel')
    markEdited()
    await persistDraft()
  }

  async function forgetKey() {
    draft.provider.apiKey = ''
    providerEdits.add('apiKey')
    markEdited()
    await persistDraft()
  }

  async function forgetArbKey() {
    draft.arbitrator.apiKey = ''
    arbitratorEdits.add('apiKey')
    markEdited()
    await persistDraft()
  }

  function openWipe() {
    wipeConfirm = ''
    wipeOpen = true
  }

  async function doWipe() {
    if (wipeConfirm !== 'DELETE' || $activeRunId) return
    await wipeAll()
    wipeOpen = false
    wipeConfirm = ''
    t.success($_('settings.wiped'))
  }
</script>

<TopBar title={$_('settings.title')} subtitle={$_('settings.subtitle')} />

{#if saveError}
  <div class="save-error" role="alert">
    <span>{saveError}</span>
    <Button size="sm" variant="secondary" disabled={saving > 0} onclick={() => void persistDraft()}>{$_('common.retry')}</Button>
  </div>
{/if}

<div class="grid">
  <section class="card surface">
    <h3>{$_('settings.provider')}</h3>
    <div class="quick-setup">
      <div>
        <strong>{$_('settings.ollamaTitle')}</strong>
        <p>{$_('settings.ollamaBody')}</p>
      </div>
      <Button variant="secondary" onclick={useLocalOllama} loading={detectingOllama}>
        {$_('settings.ollamaUse')}
      </Button>
    </div>
    <div class="quick-setup">
      <div>
        <strong>{$_('settings.demoTitle')}</strong>
        <p>{$_('settings.demoBody')}</p>
      </div>
      <Button variant="secondary" onclick={useDemoProvider}>
        {$_('settings.demoUse')}
      </Button>
    </div>
    {#if ollamaMessage}
      <Tag tone={ollamaOk ? 'ok' : 'err'}>{ollamaMessage}</Tag>
    {/if}
    <div class="form">
      <TextField bind:value={draft.provider.label} label={$_('settings.label')} oninput={scheduleSave} />
      <TextField
        bind:value={draft.provider.baseUrl}
        label={$_('settings.baseUrl')}
        hint="https://openrouter.ai/api/v1"
        validate={(v) => !validBaseUrl(v) ? 'Must start with http://, https://, or mock://' : null}
        oninput={scheduleSave}
      />
      <div class="api-key">
        <TextField
          bind:value={draft.provider.apiKey}
          label={$_('settings.apiKey')}
          type={showKey ? 'text' : 'password'}
          placeholder="sk-..."
          validate={(v) => isKeylessProvider(draft.provider.baseUrl) || v.trim() ? null : 'API key is required'}
          oninput={scheduleSave}
        />
        <div class="api-actions">
          <button class="link" type="button" onclick={() => (showKey = !showKey)}>
            {showKey ? $_('settings.hideKey') : $_('settings.showKey')}
          </button>
          <button
            class="link danger"
            type="button"
            onclick={forgetKey}
          >{$_('settings.forget')}</button>
        </div>
        <Tag tone={isKeylessProvider(draft.provider.baseUrl) ? 'info' : 'warn'}>
          {$_(isKeylessProvider(draft.provider.baseUrl) ? 'settings.localNoKey' : 'settings.apiKeyWarning')}
        </Tag>
      </div>
      <TextField
        bind:value={draft.provider.targetModel}
        label={$_('settings.targetModel')}
        hint="openai/gpt-4o-mini"
        validate={(v) => v.trim() ? null : 'Model is required'}
        oninput={scheduleSave}
      />
      <TextField
        bind:value={draft.provider.judgeModel}
        label={$_('settings.judgeModel')}
        hint="openai/gpt-4o - {$_('settings.judgeModelHint')}"
        validate={(v) => v.trim() ? null : 'Model is required'}
        oninput={scheduleSave}
      />
      <div class="model-actions">
        <Button size="sm" variant="ghost" onclick={useTargetForJudge}>{$_('settings.useTargetForJudge')}</Button>
      </div>
      <NumberField
        bind:value={draft.provider.requestTimeoutMs}
        label={$_('settings.timeout')}
        min={1000}
        step={1000}
        validate={(v) => v < 1000 ? 'Minimum 1000 ms' : null}
        oninput={scheduleSave}
      />
      <NumberField
        bind:value={draft.provider.maxRetries}
        label={$_('settings.maxRetries')}
        min={0}
        max={10}
        validate={(v) => v < 0 || v > 10 ? '0 to 10' : null}
        oninput={scheduleSave}
      />
      <div class="rate-limit-panel">
        <div class="rate-limit-head">
          <div>
            <h4>{$_('settings.modelRateLimits')}</h4>
            <p>{$_('settings.modelRateLimitsBody')}</p>
          </div>
          <div class="rate-limit-buttons">
            <Button size="sm" variant="secondary" onclick={addCurrentModelLimits}>
              {$_('settings.modelRateLimitAddCurrent')}
            </Button>
            <Button size="sm" variant="ghost" onclick={() => addRateLimit()}>
              {$_('settings.modelRateLimitAdd')}
            </Button>
          </div>
        </div>

        {#if !rateLimits().length}
          <p class="rate-limit-empty">{$_('settings.modelRateLimitsEmpty')}</p>
        {:else}
          <div class="rate-limit-list">
            {#each rateLimits() as rule (rule.id)}
              <div class="rate-limit-row">
                <label class="rate-limit-enabled">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onchange={(e) => updateRateLimit(rule.id, { enabled: (e.currentTarget as HTMLInputElement).checked })}
                  />
                  <span>{$_('settings.modelRateLimitEnabled')}</span>
                </label>
                <TextField
                  value={rule.model}
                  label={$_('settings.modelRateLimitModel')}
                  hint="google/gemma-4-26b-a4b-it:free"
                  validate={(v) => v.trim() ? null : 'Model is required'}
                  oninput={(value) => updateRateLimit(rule.id, { model: value })}
                />
                <NumberField
                  value={rule.requestsPerMinute}
                  label={$_('settings.modelRateLimitRpm')}
                  min={1}
                  max={3600}
                  validate={(v) => v < 1 || v > 3600 ? '1 to 3600' : null}
                  oninput={(value) => updateRateLimit(rule.id, { requestsPerMinute: value })}
                />
                <div class="rate-limit-actions">
                  <Button size="sm" variant="ghost" onclick={() => removeRateLimit(rule.id)}>
                    {$_('settings.modelRateLimitRemove')}
                  </Button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
    <div class="row">
      {#if dirty && !saveError}
        <Tag tone="neutral">{$_(saving ? 'common.saving' : 'common.unsaved')}</Tag>
      {/if}
      {#if savedAt}
        <Tag tone="ok">{$_('actions.saved')}</Tag>
      {/if}
      <Button onclick={testConnection} loading={testing} variant="secondary">
        {$_('settings.test')}
        {#if testResult === 'ok'}<Tag tone="ok">{$_('settings.testOk')}</Tag>{/if}
        {#if testResult === 'fail'}<Tag tone="err">{$_('settings.testFail')}</Tag>{/if}
      </Button>
    </div>
  </section>

  <section class="card surface arb-card">
    <div class="arb-head">
      <div>
        <h3>{$_('settings.arbitrator')}</h3>
        <p class="muted">{$_('settings.arbitratorBody')}</p>
      </div>
      <label class="toggle">
        <input
          type="checkbox"
          bind:checked={draft.arbitrator.enabled}
          onchange={scheduleSave}
        />
        <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span>
        <span class="toggle-label">{$_('settings.arbitratorEnable')}</span>
      </label>
    </div>

    {#if draft.arbitrator.enabled}
      <div class="form">
        <TextField
          bind:value={draft.arbitrator.baseUrl}
          label={$_('settings.arbitratorUrl')}
          hint="https://api.openai.com/v1"
          validate={(v) => !v.startsWith('http://') && !v.startsWith('https://') ? 'Must start with http:// or https://' : null}
          oninput={scheduleSave}
        />
        <div class="api-key">
          <TextField
            bind:value={draft.arbitrator.apiKey}
            label={$_('settings.arbitratorApiKey')}
            type={showArbKey ? 'text' : 'password'}
            placeholder="sk-..."
            oninput={scheduleSave}
          />
          <div class="api-actions">
            <button class="link" type="button" onclick={() => (showArbKey = !showArbKey)}>
              {showArbKey ? $_('settings.hideKey') : $_('settings.showKey')}
            </button>
            <button class="link danger" type="button" onclick={forgetArbKey}>
              {$_('settings.forget')}
            </button>
          </div>
        </div>
        <TextField
          bind:value={draft.arbitrator.model}
          label={$_('settings.arbitratorModel')}
          hint="openai/o1-mini"
          validate={(v) => v.trim() ? null : 'Model is required'}
          oninput={scheduleSave}
        />
        <p class="muted arb-hint">{$_('settings.arbitratorHint')}</p>
      </div>
    {/if}
  </section>

  <section class="card surface">
    <h3>{$_('settings.language')}</h3>
    {#if languageError}<p role="alert" class="language-error">{languageError}</p>{/if}
    <div class="lang-row">
      <button class="lang" class:active={$settings.lang === 'en'} onclick={() => void changeLanguage('en')} disabled={changingLanguage}>
        English
      </button>
      <button class="lang" class:active={$settings.lang === 'ru'} onclick={() => void changeLanguage('ru')} disabled={changingLanguage}>
        Русский
      </button>
    </div>
  </section>

  <section class="card surface danger-card">
    <h3>{$_('settings.danger')}</h3>
    <p class="muted">{$_('settings.wipe')}</p>
    <div class="row">
      <Button variant="danger" disabled={!!$activeRunId} onclick={openWipe}>{$_('settings.wipe')}</Button>
    </div>
  </section>
</div>

<Dialog bind:open={wipeOpen} title={$_('settings.danger')}>
  <p class="muted">{$_('settings.wipe')}</p>
  <p class="prompt">{$_('settings.wipeConfirm')}</p>
  <input
    class="wipe-input"
    type="text"
    bind:value={wipeConfirm}
    placeholder={$_('settings.wipeConfirm')}
  />
  {#snippet actions()}
    <Button variant="ghost" onclick={() => (wipeOpen = false)}>{$_('common.cancel')}</Button>
    <Button variant="danger" disabled={wipeConfirm !== 'DELETE'} onclick={doWipe}>
      {$_('settings.wipe')}
    </Button>
  {/snippet}
</Dialog>

<style>
  .save-error { display:flex; align-items:center; gap:16px; margin-bottom:20px; color:var(--err); }
  .language-error { color:var(--err); }
  .grid { display: grid; grid-template-columns: 1fr; gap: var(--s-4); max-width: 720px; }
  .card { padding: var(--s-5); display: flex; flex-direction: column; gap: var(--s-4); min-width: 0; }
  h3 { font-size: var(--fs-lg); }
  .form { display: flex; flex-direction: column; gap: var(--s-3); }
  .row { display: flex; gap: var(--s-2); align-items: center; flex-wrap: wrap; }
  .quick-setup {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    padding: var(--s-3);
    background: var(--bg-2);
    border: 1px solid var(--border-1);
    border-radius: var(--r-md);
  }
  .quick-setup strong { display: block; margin-bottom: 2px; font-size: var(--fs-sm); }
  .quick-setup p { margin: 0; color: var(--ink-3); font-size: var(--fs-sm); max-width: 48ch; }
  .api-key { display: flex; flex-direction: column; gap: var(--s-2); }
  .api-key :global(.tag) {
    align-self: flex-start;
    max-width: 100%;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .api-actions { display: flex; gap: var(--s-3); }
  .model-actions { display: flex; justify-content: flex-end; margin-top: calc(var(--s-2) * -1); }
  .rate-limit-panel {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    padding: var(--s-3);
    background: var(--bg-2);
    border: 1px solid var(--border-1);
    border-radius: var(--r-md);
    min-width: 0;
  }
  .rate-limit-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-3);
    flex-wrap: wrap;
  }
  .rate-limit-head h4 {
    margin: 0 0 var(--s-1);
    font-size: var(--fs-sm);
  }
  .rate-limit-head p,
  .rate-limit-empty {
    margin: 0;
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .rate-limit-buttons {
    display: flex;
    gap: var(--s-2);
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .rate-limit-list {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .rate-limit-row {
    display: grid;
    grid-template-columns: minmax(96px, 0.6fr) minmax(180px, 1.6fr) minmax(112px, 0.7fr) auto;
    align-items: end;
    gap: var(--s-2);
    min-width: 0;
  }
  .rate-limit-enabled {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-height: 40px;
    color: var(--ink-2);
    font-size: var(--fs-sm);
  }
  .rate-limit-enabled input {
    width: 16px;
    height: 16px;
    accent-color: var(--primary);
  }
  .rate-limit-actions {
    display: flex;
    align-items: flex-end;
    min-height: 40px;
  }
  .link { appearance: none; background: none; border: none; color: var(--secondary); font: inherit; font-size: var(--fs-sm); cursor: pointer; padding: 0; }
  .link:hover { text-decoration: underline; }
  .link.danger { color: var(--err); }
  .lang-row { display: flex; gap: var(--s-2); }
  .lang {
    appearance: none; background: var(--bg-2); border: 1px solid var(--border-1);
    color: var(--ink-2); padding: var(--s-2) var(--s-4); border-radius: var(--r-md);
    font: inherit; cursor: pointer; transition: background var(--dur-fast) var(--ease);
  }
  .lang:hover { background: var(--bg-3); }
  .lang.active { background: var(--primary); color: var(--primary-fg); border-color: transparent; }
  .danger-card { border-color: rgba(243, 184, 179, 0.2); }
  .wipe-input {
    width: 100%; height: 38px; padding: 0 var(--s-3);
    background: var(--bg-1); border: 1px solid var(--border-1); border-radius: var(--r-md);
    color: var(--ink-1); font: inherit; margin-top: var(--s-2);
  }
  .wipe-input:focus { outline: none; border-color: var(--err); }
  .muted { color: var(--ink-3); margin: 0 0 var(--s-2); }
  .prompt { font-weight: 500; margin: var(--s-2) 0 0; }

  .arb-card { gap: var(--s-3); }
  .arb-head {
    display: flex; justify-content: space-between; align-items: flex-start; gap: var(--s-4);
    flex-wrap: wrap;
  }
  .arb-head h3 { margin: 0 0 var(--s-1); }
  .arb-hint { font-size: var(--fs-xs); margin: var(--s-1) 0 0; }
  .toggle {
    display: inline-flex; align-items: center; gap: var(--s-2);
    cursor: pointer; font-size: var(--fs-sm); color: var(--ink-2);
    flex-shrink: 0;
  }
  .toggle input { position: absolute; opacity: 0; pointer-events: none; }
  .toggle-track {
    width: 36px; height: 20px; background: var(--bg-3); border: 1px solid var(--border-1);
    border-radius: 999px; position: relative; transition: background var(--dur-fast) var(--ease);
    display: inline-block;
  }
  .toggle-thumb {
    position: absolute; top: 1px; left: 1px;
    width: 16px; height: 16px; background: var(--bg-1); border-radius: 50%;
    transition: transform var(--dur-fast) var(--ease);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  }
  .toggle input:checked + .toggle-track { background: var(--primary); border-color: transparent; }
  .toggle input:checked + .toggle-track .toggle-thumb { transform: translateX(16px); }
  .toggle input:focus-visible + .toggle-track { box-shadow: 0 0 0 3px rgba(238, 183, 124, 0.24); }
  .toggle-label { user-select: none; }

  @media (max-width: 680px) {
    .rate-limit-buttons { justify-content: flex-start; width: 100%; }
    .rate-limit-row { grid-template-columns: 1fr; align-items: stretch; }
    .rate-limit-actions { justify-content: flex-start; }
  }
</style>
