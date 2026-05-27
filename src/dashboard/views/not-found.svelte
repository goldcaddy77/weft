<script lang="ts">
  import { navigate } from '../router.svelte.ts';
  import { search } from '../icons.ts';
  import EmptyState from '../components/empty-state.svelte';
  import Button from '../components/button.svelte';

  function handleGoHome(): void {
    navigate('/');
  }
</script>

<div class="not-found-container">
  <EmptyState icon={search(48)} title="Page not found" description="The page you are looking for does not exist.">
    {#snippet action()}
      <Button variant="primary" size="md" label="Go to Dashboard" onclick={handleGoHome} />
    {/snippet}
  </EmptyState>
</div>

<style>
  .not-found-container {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 60vh;
  }
</style>
