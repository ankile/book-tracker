<script>
  const title = 'Book Tracker';
</script>

<div class="launch-screen" role="status" aria-live="polite">
  <div class="brand">
    <div class="book" aria-hidden="true">
      <span class="page left-page"></span>
      <span class="page right-page"></span>
    </div>
    <h1>{title}</h1>
    <p>Opening your library…</p>
    <span class="loading-indicator" aria-hidden="true"></span>
  </div>
</div>

<style>
  .launch-screen {
    box-sizing: border-box;
    display: grid;
    min-height: calc(
      100vh - env(safe-area-inset-top) - env(safe-area-inset-bottom)
    );
    min-height: calc(
      100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom)
    );
    place-items: center;
    padding: 1.5rem;
    overflow: hidden;
    color: white;
    background:
      radial-gradient(circle at 50% 35%, rgb(255 255 255 / 14%), transparent 18rem),
      linear-gradient(145deg, #35686a, #2f5f61);
  }

  .brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    transform: translateY(-3vh);
  }

  .book {
    position: relative;
    width: 5rem;
    height: 3.75rem;
    margin-bottom: 1.4rem;
    filter: drop-shadow(0 0.65rem 0.8rem rgb(30 67 69 / 22%));
  }

  .book::after {
    position: absolute;
    right: 50%;
    bottom: 0.25rem;
    width: 1px;
    height: 3rem;
    content: '';
    background: rgb(77 137 140 / 35%);
  }

  .page {
    position: absolute;
    bottom: 0;
    width: 50%;
    height: 3.4rem;
    background: #fffdf7;
  }

  .left-page {
    left: 0;
    border-radius: 0.45rem 0.15rem 0.2rem 0.45rem;
    transform: skewY(5deg);
    transform-origin: right bottom;
  }

  .right-page {
    right: 0;
    border-radius: 0.15rem 0.45rem 0.45rem 0.2rem;
    transform: skewY(-5deg);
    transform-origin: left bottom;
  }

  h1 {
    margin: 0;
    font-family: ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, sans-serif;
    font-size: clamp(2rem, 8vw, 2.75rem);
    font-weight: 700;
    letter-spacing: -0.035em;
  }

  p {
    margin: 0.55rem 0 1.75rem;
    color: white;
    font-size: 0.95rem;
  }

  .loading-indicator {
    width: 1.25rem;
    height: 1.25rem;
    border: 2px solid rgb(255 255 255 / 32%);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .loading-indicator {
      animation: none;
      border-color: rgb(255 255 255 / 55%);
    }
  }
</style>
