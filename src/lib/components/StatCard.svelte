<script>
  let { label, value, subtext, href = null } = $props();
</script>

<style>
  .card {
    display: block;
    padding: 2rem;
    color: inherit;
    text-align: left;
    text-decoration: none;
    background: white;
    border-radius: 5px;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2), 0 6px 20px rgba(0, 0, 0, 0.19);
  }

  a.card {
    cursor: pointer;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  a.card:hover {
    color: inherit;
    transform: translateY(-4px);
    box-shadow: 0 6px 12px rgba(0, 0, 0, 0.25), 0 8px 24px rgba(0, 0, 0, 0.22);
  }

  .label {
    margin-bottom: 0.5rem;
    color: #666;
    font-size: 0.9rem;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }

  .value {
    margin: 0;
    color: #333;
    font-size: 2.5rem;
    font-weight: 700;
    line-height: 1.2;
  }

  .subtext {
    margin-top: 0.25rem;
    color: #777;
    font-size: 0.85rem;
  }

  @media (max-width: 768px) {
    .value {
      font-size: 2rem;
    }
  }
</style>

{#snippet contents()}
  <div class="label">{label}</div>
  <div class="value">{value}</div>
  <div class="subtext">{subtext}</div>
{/snippet}

{#if href}
  <a class="card" {href}>
    {@render contents()}
  </a>
{:else}
  <div class="card">
    {@render contents()}
  </div>
{/if}
