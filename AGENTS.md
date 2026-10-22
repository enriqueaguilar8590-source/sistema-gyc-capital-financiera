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
- Client history/payment index (`GycRules.clientHistory`): rates installments on time, paid late (any mora paid or waived) or overdue; Buena >=85%, Media 60-84%, Mala <60% or >30 days overdue; any overdue installment caps at Media. Test credits are excluded.
- Accounting lives in the ID-keyed workspace array `conta` (administrator-only, protected server-side like other financial keys). Entries are never deleted, only voided with a reason (`anulado`). Real profit is cash-basis: interest + mora collected + other income - expenses; withdrawals are not expenses. The balance sheet estimates cash from recorded flows (partner contributions, initial capital, collections, disbursements, movements) and values the portfolio at outstanding capital. Note that cobradores can still read `conta` at the database level; only the UI hides it.
- Accounting movements can be corrected (`GycRules.applyEntryEdit`): the result is re-validated, a reason is required, and before/after values are appended to the entry's `ediciones`; voided entries cannot be edited. Renaming a partner (`GycRules.applyPartnerEdit`) requires the Socios key, a unique name and a reason, and keeps the previous name in the partner's `ediciones`. Contributions stay linked by `socioId`, so renames never orphan them.
