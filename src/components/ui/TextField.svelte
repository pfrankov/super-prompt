<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    value = $bindable(''),
    label,
    placeholder = '',
    type = 'text',
    hint = '',
    error = '',
    disabled = false,
    readonly = false,
    autofocus = false,
    id = '',
    name = '',
    autocomplete = 'off',
    validate = undefined as ((v: string) => string | null) | undefined,
    onchange,
    oninput,
    onblur,
    onenter,
  }: {
    value?: string
    label?: string
    placeholder?: string
    type?: 'text' | 'password' | 'email' | 'number' | 'url' | 'search'
    hint?: string
    error?: string
    disabled?: boolean
    readonly?: boolean
    autofocus?: boolean
    id?: string
    name?: string
    autocomplete?: HTMLInputElement['autocomplete']
    validate?: (v: string) => string | null
    onchange?: (v: string) => void
    oninput?: (v: string) => void
    onblur?: (v: string) => void
    onenter?: () => void
  } = $props()

  const autoId = $props.id()
  const fieldId = $derived(id || `tf-${autoId}`)
  let internalError = $state('')
  const effectiveError = $derived(error || internalError)
</script>

<label class="field" for={fieldId}>
  {#if label}<span class="label">{label}</span>{/if}
  <input
    bind:value
    {type}
    {placeholder}
    {disabled}
    {readonly}
    name={name || undefined}
    {autocomplete}
    id={fieldId}
    aria-describedby={effectiveError ? `${fieldId}-err` : hint ? `${fieldId}-hint` : undefined}
    aria-invalid={!!effectiveError}
    onchange={() => onchange?.(value)}
    oninput={() => { internalError = ''; oninput?.(value) }}
    onblur={() => {
      if (validate) internalError = validate(value) ?? ''
      onblur?.(value)
    }}
    onkeydown={(e) => { if (e.key === 'Enter') onenter?.() }}
  />
  {#if effectiveError}
    <span id="{fieldId}-err" class="error" role="alert">{effectiveError}</span>
  {:else if hint}
    <span id="{fieldId}-hint" class="hint">{hint}</span>
  {/if}
</label>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    min-width: 0;
  }
  .label {
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--ink-2);
  }
  input {
    appearance: none;
    background: color-mix(in srgb, var(--bg-2) 78%, black);
    border: 1px solid var(--border-1);
    border-radius: var(--r-md);
    padding: 0 var(--s-3);
    height: 40px;
    color: var(--ink-1);
    font: inherit;
    transition:
      border-color var(--dur-fast) var(--ease),
      background-color var(--dur-fast) var(--ease),
      box-shadow var(--dur-fast) var(--ease);
    width: 100%;
  }
  input::placeholder { color: var(--ink-3); }
  input:hover:not(:disabled):not(:focus) {
    background: color-mix(in srgb, var(--bg-2) 88%, black);
    border-color: var(--border-2);
  }
  input:focus {
    outline: none;
    border-color: rgba(238, 183, 124, 0.65);
    box-shadow: 0 0 0 3px rgba(238, 183, 124, 0.11);
  }
  input:disabled { opacity: 0.5; cursor: not-allowed; }
  input[aria-invalid="true"] { border-color: var(--err); }
  .hint { font-size: var(--fs-xs); color: var(--ink-3); }
  .error { font-size: var(--fs-xs); color: var(--err); }
</style>
