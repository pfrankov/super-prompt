<script lang="ts">
  let {
    value = $bindable(''),
    label,
    options,
    hint = '',
    disabled = false,
    id = '',
  }: {
    value?: string
    label?: string
    options: { value: string; label: string }[]
    hint?: string
    disabled?: boolean
    id?: string
  } = $props()

  const autoId = $props.id()
  const fieldId = $derived(id || `sel-${autoId}`)
</script>

<label class="field" for={fieldId}>
  {#if label}<span class="label">{label}</span>{/if}
  <div class="wrap">
    <select bind:value {disabled} id={fieldId}>
      {#each options as opt (opt.value)}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
    <svg class="chev" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </div>
  {#if hint}<span class="hint">{hint}</span>{/if}
</label>

<style>
  .field { display: flex; flex-direction: column; gap: var(--s-2); }
  .label { font-size: var(--fs-sm); font-weight: 500; color: var(--ink-2); }
  .wrap { position: relative; }
  select {
    appearance: none;
    background: color-mix(in srgb, var(--bg-2) 78%, black);
    border: 1px solid var(--border-1);
    border-radius: var(--r-md);
    padding: 0 var(--s-8) 0 var(--s-3);
    height: 40px;
    color: var(--ink-1);
    font: inherit;
    transition:
      border-color var(--dur-fast) var(--ease),
      background-color var(--dur-fast) var(--ease),
      box-shadow var(--dur-fast) var(--ease);
    width: 100%;
    cursor: pointer;
  }
  select:hover:not(:disabled):not(:focus) {
    background: color-mix(in srgb, var(--bg-2) 88%, black);
    border-color: var(--border-2);
  }
  select:focus {
    outline: none;
    border-color: rgba(238, 183, 124, 0.65);
    box-shadow: 0 0 0 3px rgba(238, 183, 124, 0.11);
  }
  .chev {
    position: absolute;
    right: var(--s-3);
    top: 50%;
    transform: translateY(-50%);
    width: 14px; height: 14px;
    color: var(--ink-3);
    pointer-events: none;
  }
  .hint { font-size: var(--fs-xs); color: var(--ink-3); }
</style>
