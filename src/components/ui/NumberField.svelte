<script lang="ts">
  let {
    value = $bindable(0),
    label,
    min = 0,
    max = Infinity,
    step = 1,
    hint = '',
    hintMode = 'visible',
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
    hintMode?: 'visible' | 'hover'
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

<label class="field" class:hover-hint={hintMode === 'hover'} for={fieldId}>
  {#if label}
    <span class="label-row">
      <span class="label">{label}</span>
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
    transition:
      opacity 160ms var(--ease-out),
      max-height 180ms var(--ease-out),
      transform 160ms var(--ease-out);
  }
  .hover-hint .hint {
    max-height: 0;
    opacity: 0;
    overflow: hidden;
    transform: translateY(-2px);
  }
  .hover-hint:hover .hint,
  .hover-hint:focus-within .hint {
    max-height: 120px;
    opacity: 1;
    transform: translateY(0);
  }
  .error { font-size: var(--fs-xs); color: var(--err); }
</style>
