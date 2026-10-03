<script lang="ts">
  import type { Snippet } from 'svelte'
  import Tag from '../ui/Tag.svelte'
  let { title, subtitle, tags, compact = false, children }: { title: string; subtitle?: string; tags?: { tone?: 'neutral'|'ok'|'warn'|'err'|'info'|'accent'; label: string }[]; compact?: boolean; children?: Snippet } = $props()
</script>

<header class="bar" class:compact>
  <div class="info">
    <h1>{title}</h1>
    {#if subtitle}<p class="subtitle">{subtitle}</p>{/if}
  </div>
  {#if tags?.length}
    <div class="tags">
      {#each tags as t (t.label)}
        <Tag tone={t.tone ?? 'neutral'}>{t.label}</Tag>
      {/each}
    </div>
  {/if}
  {#if children}
    <div class="actions">{@render children()}</div>
  {/if}
</header>

<style>
  .bar {
    display: flex;
    align-items: flex-start;
    gap: var(--s-4);
    padding-bottom: 28px;
    margin-bottom: 8px;
    border-bottom: 1px solid var(--border-1);
    flex-wrap: wrap;
  }
  .info { flex: 1 1 220px; min-width: 0; }
  h1 {
    font-size: clamp(24px, 2vw, 28px);
    font-weight: 550;
    letter-spacing: -0.025em;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .subtitle {
    margin: 9px 0 0;
    color: var(--ink-3);
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
  .compact { padding-bottom: 0; margin-bottom: 20px; border-bottom: none; align-items: center; }
  .compact h1 { font-size: 20px; letter-spacing: -0.015em; }
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
    .compact { flex-direction: row; gap: var(--s-2); margin-bottom: var(--s-3); }
    .compact .info { flex: 1; }
    .compact .actions { width: auto; margin-left: auto; }
  }
</style>
