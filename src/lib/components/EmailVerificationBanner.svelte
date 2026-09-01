<script lang="ts">
  import { user, confirmEmailVerified, resendVerificationEmail } from '$lib/firebase/auth.ts';
  import { RESEND_COOLDOWN_MS, canResend } from '$lib/firebase/emailVerification.ts';
  import { describeAuthFailure } from '$lib/utils/authFailure.ts';

  // Shown to a signed-in account whose address is not verified yet —
  // a fresh sign-up that has a link in its inbox, or an account from
  // before verification existed that has never been sent one; nobody is
  // grandfathered, the wording covers both. It informs and offers the
  // two actions; it blocks nothing — the features that need the claim
  // (publishing a profile today, the shared catalog next) refuse on
  // their own and point back here.
  let busy = $state(false);
  let message = $state('');
  let lastSentAt = $state<number | null>(null);
  let now = $state(Date.now());
  const resendReady = $derived(canResend(lastSentAt, now));

  async function check() {
    busy = true;
    message = '';
    try {
      const verified = await confirmEmailVerified();
      if (!verified) message = 'Not verified yet. Open the link in the email, then try again.';
    } catch (error) {
      message = describeAuthFailure(error).userMessage;
    } finally {
      busy = false;
    }
  }

  async function resend() {
    now = Date.now();
    if (!resendReady) return;
    busy = true;
    message = '';
    try {
      await resendVerificationEmail();
      lastSentAt = Date.now();
      now = lastSentAt;
      message = 'Sent. Check your inbox and spam folder.';
      setTimeout(() => (now = Date.now()), RESEND_COOLDOWN_MS);
    } catch (error) {
      message = describeAuthFailure(error).userMessage;
    } finally {
      busy = false;
    }
  }
</script>

<style>
  .verification {
    max-width: 700px;
    margin: 0 auto 0.75rem;
    text-align: left;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 0.5rem;
  }

  .message {
    margin: 0.5rem 0 0;
  }
</style>

{#if $user && !$user.emailVerified}
  <div class="alert alert-warning verification" role="status">
    <strong>Verify your email address.</strong>
    Until you do, author names stay hidden and books can't be added or edited
    (the shared author catalog is verified-only). Use the link in the email we
    sent to {$user.email}, or request a new one.
    <div class="actions">
      <button type="button" class="btn btn-sm btn-dark" onclick={check} disabled={busy}>
        I've verified
      </button>
      <button
        type="button"
        class="btn btn-sm btn-outline-dark"
        onclick={resend}
        disabled={busy || !resendReady}>
        Send verification email
      </button>
    </div>
    {#if message}
      <p class="message">{message}</p>
    {/if}
  </div>
{/if}
