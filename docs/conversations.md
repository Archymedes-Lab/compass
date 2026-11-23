# Conversational task updates

People can use **Talk to Compass** (`/#conversation`) or reply in plain text to a new daily briefing. GPT-6 Luna interprets the message, applies clear requests, and asks a question when the reference or intent is ambiguous. Changes appear in the normal task/project views. The app refreshes conversation turns every three seconds while visible, and the workspace refreshes on completed turns and at its normal ten-second interval.

Messages and Luna replies preserve Markdown whitespace through credential scrubbing and storage. Chat and HTML email use the same CommonMark/GitHub-style renderer for headings, emphasis, lists, task lists, tables, quotes and code. Raw HTML and unsafe URL schemes are excluded; image syntax displays its description without fetching remote images. Confirmation emails also include the original Markdown as a plain-text alternative. Previously flattened messages cannot recover their original line breaks.

## Architecture

Both channels write to the same SQLite inbox in the existing Durable Object. A message moves from `queued` to `working` to `complete`. A short alarm starts processing automatically; the fifteen-minute cron recovers missed alarms. The development server drains every five seconds. No client needs to stay connected while a message is processed.

Each message has a source ID, bounded retries, a two-minute processing lease, model usage and a durable response. An interrupted model call can be retried; committed operations and the completed response are stored in one transaction, so a delivery retry cannot replay mutations. Confirmation email is a separate outbox step with a Resend idempotency key and three delivery attempts. A failed confirmation does not roll back a saved task update. Errors remain visible in the conversation.

Luna returns a strict JSON plan containing only supported operations: change status, revise a task's title/detail/done criteria, create a task for the sender, or save a project report. Every operation includes a quote from the current message. The executor validates task/project references, ownership, approval blockers and prerequisites, then records before/after evidence and attribution. The model cannot execute commands, send to arbitrary addresses, grant approval, move ownership or lanes, change the company brief, fabricate metrics, or delete tasks. Cancellation uses reversible `dropped` status. New tasks and content edits enter the existing judgment queue; completing work frees the person's quest for normal reassignment.

The executor compares current workspace context with the snapshot used by Luna. Concurrent changes cause a fresh-context retry. It applies a message's operations atomically; an invalid operation rolls back the batch and returns a clarification. Model suggestions and quoted email are not new authorization. Natural-language interpretation remains model-dependent: the saved-change list and history are the authoritative receipt.

## Email configuration

- `COMPASS_RECEIVING_DOMAIN=your-inbound.resend.app` uses the supplied Resend-managed receiving domain. Root-domain MX records are not changed.
- The existing `RESEND_API_KEY` must permit receiving email and webhook management as well as sending. With those permissions, the Worker provisions or reuses exactly `https://compass.archymedes.xyz/api/email/inbound`, subscribed to `email.received`. It stores the returned signing secret in `conversation_secrets`, excluded from workspace exports and tool responses. Setup failures are visible in the conversation screen and retried on a later alarm.
- Alternatively set `RESEND_WEBHOOK_SECRET` and configure the matching Resend webhook manually. `SESSION_KEY` derives each reply address's HMAC. Rotating it invalidates old reply addresses.
- Existing digest recipients determine identity. Each new briefing gets a distinct reply address under the receiving domain and a frozen copy of its original task references. Replies must match that address, the original recipient, and the recipient's current saved email; removed users and changed addresses lose access. Threads accept replies for 90 days. Treat a briefing's reply address as a private capability and avoid forwarding it to untrusted parties; email sender headers alone are not proof of identity.
- Webhook signatures are verified against the raw body with a five-minute timestamp window. The application fetches content directly from Resend after verification, ignores auto-responders and mailing-list messages, strips common quoted/forwarded sections, and processes only plain text. It never fetches attachments or email links. Provider retries use the received email ID for deduplication.
- Luna emails the original person a saved-change receipt or clarification, with `Reply-To` pointing back to that conversation and `In-Reply-To` when available. Continue replying normally. Web conversations and email conversations are both available in the conversation selector to the signed-in person only.
- Briefings sent before this feature have no new reply address; use a newly sent briefing. A human can use the existing **Send now** control to obtain one.

## Controls and limits

Defaults: 30 new messages per person per UTC day, $0.30 workspace daily model allowance, and a $0.01 reservation per model attempt. These are separate from adaptive research-planning allowances. Retries retain reservations, including ambiguous or interrupted provider requests. Actual reported cost above the reservation stops that message. Provider price limits and a 2,500-token output ceiling bound requests. Existing task judging has its own provider usage; the conversation allowance does not cover judgment or Resend charges.

People can pause all conversation updates or only email processing and edit message/spend limits in **Talk to Compass → Automation controls**. Pausing in flight prevents applying the returned plan. Agents can read readiness through `GET /api/conversation/status`, but cannot read personal conversations or submit messages as a person. The authenticated web endpoints use the existing session and same-site cookies.

History retains scrubbed messages, model responses and before/after changes in SQLite and includes them in human workspace exports. Email capability secrets are excluded. There is no automatic retention purge or dedicated one-click undo; ask to reopen/revise the task or use its normal controls.

## Validation

`bun run typecheck`, `bun test tests`, `bun run build`, and a Worker deployment dry run cover schemas, execution, ownership, blockers, concurrent edits, deduplication, retries, reservations, signature checks, sender/address binding, quoting, outbox delivery and secret exclusion. Local fake-provider tests do not establish real inbound delivery or Luna's interpretation of a real message. Verify a newly sent briefing, actual human reply, stored task update and confirmation before calling the complete mail loop verified.
