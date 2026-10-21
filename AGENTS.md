<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Keep the existing standalone system UI; share browser-safe permission and cash-report rules through a public script tested with Vitest.
- Team membership roles are authoritative in the database; legacy internal user permissions can only narrow cloud permissions, and workspace writes must validate role-specific changes server-side.
- Store partners and append-only capital contributions as ID-keyed workspace arrays; existing three-way merging synchronizes them and server workspace validation restricts new financial keys to administrators. Do not initialize missing arrays during read-only use, because that would create unauthorized writes.
- Editing a contributed amount in Socios is gated in the browser by a separate Socios user/password (salted PBKDF2 hash in `public/gyc-rules.js`, never the plain password). Edits keep the previous amount and reason in the contribution's `ediciones` array; contributions are never deleted. This lock is a UI safeguard; real enforcement stays with the administrator-only server validation of `socios`/`aportes`.
- Daily notices (today's collections, clients in mora/overdue) use per-device settings in localStorage (`gyc_avisos`) and the Notification API through `public/sw.js`; they only fire while the app is open or installed. Payment SMS opens the phone's messaging app with a prefilled `sms:` link built by `GycRules.paymentSms`; no SMS provider or secrets are stored in the repo.
- After a collection the app opens the SMS app by itself (per-device toggle `gyc_sms_auto`, on by default, skipped for test credits or clients without a valid phone). The dashboard notices card lists today's and overdue clients with one SMS button each; clients already messaged today are marked in `gyc_sms_sent`. Browsers cannot send SMS silently, so the user always taps Send.
