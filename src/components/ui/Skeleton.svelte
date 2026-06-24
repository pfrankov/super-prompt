<script lang="ts">
  type Variant = 'text' | 'block' | 'circle'

  let {
    width,
    height = '1em',
    variant = 'block',
    rounded = 'sm',
  }: {
    width?: string
    height?: string
    variant?: Variant
    rounded?: 'sm' | 'md' | 'lg' | 'full'
  } = $props()
</script>

<span
  class="skeleton {variant}"
  class:r-sm={rounded === 'sm'}
  class:r-md={rounded === 'md'}
  class:r-lg={rounded === 'lg'}
  class:r-full={rounded === 'full'}
  style:width={width ?? undefined}
  style:height={height}
  aria-hidden="true"
></span>

<style>
  .skeleton {
    display: inline-block;
    background: var(--bg-2);
    position: relative;
    overflow: hidden;
  }
  .skeleton::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      transparent 0%,
      var(--bg-3) 50%,
      transparent 100%
    );
    transform: translateX(-100%);
    animation: shimmer 1.6s var(--ease) infinite;
  }
  @keyframes shimmer {
    to { transform: translateX(100%); }
  }
  .text { width: 100%; height: 1em; }
  .block { width: 100%; height: 60px; }
  .circle { width: 1em; height: 1em; aspect-ratio: 1; }
  .r-sm { border-radius: var(--r-sm); }
  .r-md { border-radius: var(--r-md); }
  .r-lg { border-radius: var(--r-lg); }
  .r-full { border-radius: 50%; }
  @media (prefers-reduced-motion: reduce) {
    .skeleton::after { animation: none; }
  }
</style>
