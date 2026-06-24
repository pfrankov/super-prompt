<script lang="ts">
  import type { Snippet } from 'svelte'
  import Tag from '../ui/Tag.svelte'
  import { _ } from 'svelte-i18n'

  let { title, subtitle, tags, children }: { title: string; subtitle?: string; tags?: { tone?: 'neutral'|'ok'|'warn'|'err'|'info'|'accent'; label: string }[]; children?: Snippet } = $props()
</script>

<header class="bar">
  <div class="info">
    <h1>{title}</h1>
    {#if subtitle}<p class="subtitle">{subtitle}</p>{/if}
  </div>
  <div class="tags">
    {#each tags ?? [] as t (t.label)}
      <Tag tone={t.tone ?? 'neutral'}>{t.label}</Tag>
    {/each}
  </div>
  {#if children}
    <div class="actions">{@render children()}</div>
  {/if}
</header>

<style>
  .bar {
    display: flex;
    align-items: flex-start;
    gap: var(--s-4);
    padding-bottom: var(--s-5);
    margin-bottom: var(--s-5);
    border-bottom: 1px solid var(--border-1);
    flex-wrap: wrap;
  }
  .info { flex: 1 1 220px; min-width: 0; }
  h1 {
    font-size: clamp(var(--fs-xl), 2vw, var(--fs-2xl));
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .subtitle {
    margin: 4px 0 0;
    color: var(--ink-2);
    font-size: var(--fs-sm);
    line-height: 1.45;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    -webkit-box-orient: vertical;
  }
  .tags { display: flex; gap: var(--s-2); flex-wrap: wrap; }
  .actions { display: flex; gap: var(--s-2); align-items: center; flex-wrap: wrap; margin-left: auto; }
  @media (max-width: 720px) {
    .bar {
      flex-direction: column;
      align-items: stretch;
      padding-bottom: var(--s-3);
      margin-bottom: var(--s-3);
      gap: var(--s-3);
    }
    .info { flex-basis: auto; }
    h1 { font-size: var(--fs-xl); }
    .actions {
      width: 100%;
      justify-content: flex-start;
      margin-left: 0;
    }
  }
</style>
