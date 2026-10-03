<script lang="ts">
  import { _ } from 'svelte-i18n'
  import lockup from '../../assets/brand/superprompt-lockup-primary.svg'
</script>

<a class="brand" href="#/" aria-label={$_('app.title')}>
  <img src={lockup} alt="" aria-hidden="true" width="104" height="40" />
</a>

<style>
  .brand {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    min-height: 44px;
    padding: 2px 0;
  }
  .brand:hover { text-decoration: none; }
  img { width: 104px; height: 40px; object-fit: contain; }
</style>
