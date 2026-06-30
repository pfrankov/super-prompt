<script lang="ts">
  import Tooltip from './Tooltip.svelte'

  let {
    value = $bindable(0),
    label,
    min = 0,
    max = Infinity,
    step = 1,
    hint = '',
    tooltip = '',
    error = '',
    disabled = false,
    id = '',
    validate = undefined as ((v: number) => string | null) | undefined,
    onchange,
    oninput,
    onblur,
  }: {
    value?: number
    label?: string
    min?: number
    max?: number
    step?: number
    hint?: string
    tooltip?: string
    error?: string
    disabled?: boolean
    id?: string
    validate?: (v: number) => string | null
    onchange?: (v: number) => void
    oninput?: (v: number) => void
    onblur?: (v: number) => void
  } = $props()

  const autoId = $props.id()
  const fieldId = $derived(id || `nf-${autoId}`)
  let internalError = $state('')
  const effectiveError = $derived(error || internalError)
</script>

<label class="field" for={fieldId}>
  {#if label}
    <span class="label-row">
      <span class="label">{label}</span>
      {#if tooltip}
        <Tooltip text={tooltip} placement="top">
          <button type="button" class="info" aria-label={`${label} info`}>?</button>
        </Tooltip>
      {/if}
    </span>
  {/if}
  <input
    type="number"
    bind:value
    {min}
    {max}
    {step}
    {disabled}
    id={fieldId}
    aria-describedby={effectiveError ? `${fieldId}-err` : hint ? `${fieldId}-hint` : undefined}
    aria-invalid={!!effectiveError}
    onchange={() => onchange?.(value)}
    oninput={() => oninput?.(value)}
    onblur={() => {
      if (validate) internalError = validate(value) ?? ''
      onblur?.(value)
    }}
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
  .label-row {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-width: 0;
  }
  .label { font-size: var(--fs-sm); font-weight: 500; color: var(--ink-2); }
  .info {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border: 1px solid var(--border-2);
    border-radius: var(--r-pill);
    color: var(--ink-3);
    font-size: 10px;
    line-height: 1;
    cursor: help;
    transition:
      color var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease),
      background-color var(--dur-fast) var(--ease);
  }
  .info:hover,
  .info:focus-visible {
    color: var(--ink-1);
    border-color: rgba(238, 183, 124, 0.45);
    background: rgba(238, 183, 124, 0.08);
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
    font-variant-numeric: tabular-nums;
    transition:
      border-color var(--dur-fast) var(--ease),
      background-color var(--dur-fast) var(--ease),
      box-shadow var(--dur-fast) var(--ease);
    width: 100%;
  }
  input:hover:not(:disabled):not(:focus) {
    background: color-mix(in srgb, var(--bg-2) 88%, black);
    border-color: var(--border-2);
  }
  input:focus {
    outline: none;
    border-color: rgba(238, 183, 124, 0.65);
    box-shadow: 0 0 0 3px rgba(238, 183, 124, 0.11);
  }
  input[aria-invalid="true"] { border-color: var(--err); }
  .hint {
    font-size: var(--fs-xs);
    color: var(--ink-3);
    line-height: 1.4;
  }
  .error { font-size: var(--fs-xs); color: var(--err); }
</style>
