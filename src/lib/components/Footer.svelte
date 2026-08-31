<script lang="ts">
  interface Props {
    publicView?: boolean;
  }

  let { publicView = false }: Props = $props();
</script>

<style>
  footer {
    margin-top: 3rem;
    padding: 1.5rem 1rem;
    color: #dce9e9;
    background: #294f52;
    border-top: 4px solid #6f9b9d;
  }

  .footer-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 2rem;
    width: min(100%, 1100px);
    margin: 0 auto;
  }

  .footer-meta {
    display: flex;
    justify-content: space-between;
    gap: 1rem 2rem;
    width: min(100%, 1100px);
    margin: 1.25rem auto 0;
    padding-top: 1rem;
    color: #bed2d3;
    font-size: 0.82rem;
    border-top: 1px solid rgba(220, 233, 233, 0.22);
  }

  .footer-meta p {
    margin: 0;
  }

  .footer-meta a {
    color: #edf5f5;
    font-weight: 600;
    text-decoration: underline;
    text-decoration-color: rgba(237, 245, 245, 0.5);
    text-underline-offset: 0.2rem;
  }

  .footer-meta a:hover {
    color: white;
    text-decoration-color: white;
  }

  .identity {
    text-align: left;
  }

  .brand {
    color: white;
    font-size: 1.05rem;
    font-weight: 700;
    text-decoration: none;
  }

  .description {
    margin: 0.25rem 0 0;
    color: #bed2d3;
    font-size: 0.875rem;
  }

  nav {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.35rem 1.25rem;
  }

  nav a {
    color: #edf5f5;
    font-size: 0.9rem;
    font-weight: 600;
    text-decoration: none;
  }

  nav a:hover {
    color: white;
    text-decoration: underline;
    text-underline-offset: 0.2rem;
  }

  nav a:focus-visible,
  .footer-meta a:focus-visible,
  .brand:focus-visible {
    outline: 2px solid white;
    outline-offset: 4px;
    border-radius: 2px;
  }

  @media only screen and (max-width: 640px) {
    footer {
      margin-top: 2rem;
      padding-top: 1.25rem;
    }

    .footer-inner {
      align-items: flex-start;
      flex-direction: column;
      gap: 1rem;
    }

    nav {
      justify-content: flex-start;
      gap: 0.65rem 1.1rem;
    }

    .footer-meta {
      flex-direction: column;
      gap: 0.35rem;
    }
  }
</style>

<footer>
  <div class="footer-inner">
    <div class="identity">
      <a class="brand" href="/">Book Tracker</a>
      <p class="description">Books, reading time, and progress in one place.</p>
    </div>

    <nav aria-label="Footer navigation">
      {#if publicView}
        <a href="/" data-sveltekit-reload>Go to app</a>
      {:else}
        <a href="/">Currently reading</a>
        <a href="/finished">Finished books</a>
        <a href="/authors">Authors</a>
        <a href="/me">Dashboard</a>
      {/if}
    </nav>
  </div>

  <div class="footer-meta">
    <p>Made by <a href="https://ankile.com">Lars Ankile</a>.</p>
    <p>Questions or feedback? <a href="mailto:lars@ankile.com">lars@ankile.com</a></p>
  </div>
</footer>
