# TODO

## Send emails from my own domain (Resend)

Currently `EMAIL_FROM` is set to `onboarding@resend.dev` — Resend's own shared testing domain.

1. In the [Resend dashboard](https://resend.com/domains), add your domain.
2. Add the DNS records it gives you (SPF, DKIM, usually DMARC too) at your domain registrar/DNS provider. This is what proves to receiving mail servers you're allowed to send as that domain — without it, mail bounces or lands in spam.
3. Wait for Resend to mark the domain "Verified" (usually minutes, sometimes longer depending on DNS propagation).
4. Update `.env`: change `EMAIL_FROM` to an address on that domain, e.g. `EMAIL_FROM="alerts@yourdomain.com"`. No code change needed — `src/server/notify/email.ts` just uses this env var as the `from` address.
5. Restart the app (or redeploy on Railway) so the new env var takes effect.

`RESEND_API_KEY` doesn't need to change — the same key works for any domain verified on the account.
