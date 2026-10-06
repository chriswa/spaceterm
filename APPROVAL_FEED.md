# The approval feed

How a program on the Mac that asks for approvals — today, only opProxy — lets
you answer them from the Spaceterm phone app, as well as in its own dialog on
the Mac. Whichever answer reaches it first wins.

## Who knows what

- **The provider** (opProxy) owns everything about the request: what it shows,
  which options it offers, what they mean, and whether a reply is good enough
  to act on. It describes each request as a **document**: presentation data
  with no opProxy concepts in it.
- **Spaceterm's server only relays the feed.** It keeps the feed connected,
  hands the pending list to every phone that asks (again on every reconnect), and
  passes replies back. It never parses a document, and never decides anything.
- **The phone renders the document** from a small, general vocabulary of
  blocks, and has its replies **signed by a key that only the iPhone app's
  native code can use**. The provider trusts a reply because that key signed it,
  never because it came through Spaceterm. Anything running as you on the Mac
  can talk to the provider's socket and to Spaceterm's, so a reply that only came
  through a trusted channel would let an agent approve its own request.

A new option, a new kind of secret, a new colour or a new button is a change to
the provider's documents, and needs nothing from Spaceterm.

## Transport

A Unix stream socket the provider listens on, owner-only (opProxy:
`~/.opProxy/approval-feed.sock`). Newline-delimited JSON objects, UTF-8, in both
directions. Times are milliseconds since the epoch. The consumer reconnects
whenever the connection drops; the provider sends the full state on every
connection, so nothing needs remembering across one.

## Provider → consumer

```jsonc
{ "type": "hello", "protocol": 1, "provider": "opProxy", "pairedKeys": ["<keyId>", …] }
```
First on every connection, and again whenever the paired keys change.

```jsonc
{ "type": "snapshot", "items": [Item, …] }   // after the first hello: everything pending
{ "type": "upsert", "item": Item }           // a new request, or a changed one
{ "type": "remove", "id": "…", "note": "Approved on the Mac" }
```
An item is removed when it is answered anywhere, or times out. `note` is
optional and only for display ("Approved on the phone", "Timed out").

```jsonc
{ "type": "reply-result", "id": "…", "ok": true }
{ "type": "reply-result", "id": "…", "ok": false, "error": "That request was already answered." }
{ "type": "pair-result", "keyId": "…", "ok": true }
{ "type": "pair-result", "keyId": "…", "ok": false, "error": "Pairing was cancelled on the Mac." }
```

### Item

```jsonc
{
  "id": "…",              // opaque, unique for the provider's lifetime
  "revision": 1,          // bumped whenever `document` changes
  "createdAt": 1760000000000,
  "expiresAt": null,      // when it times out; null while it is not yet counting down
  "challenge": "…",       // opaque to everyone but the provider; echoed in the signed statement
  "document": "{…}"       // a JSON document, as a string — see below
}
```

`document` is a string so the phone can hash exactly the bytes the provider
sent. **Relays must pass it through untouched.**

### Document

```jsonc
{
  "tone": "caution",                 // "info" | "caution" | "danger"
  "kicker": "1Password security approval",
  "title": "GitHub token",           // the headline, and the list row's
  "subtitle": "Kevin (Claude Code) · “fix flaky tests”",
  "surfaceId": "…",                  // optional: the node ID of the Spaceterm surface it concerns
  "sections": [
    { "kind": "fields", "label": "Request", "rows": [ { "label": "Vault", "value": "Private" },
                                                      { "label": "Field", "value": "token", "mono": true } ] },
    { "kind": "text", "label": "Command", "text": "op read op://Private/GitHub/token", "mono": true }
  ],
  "notice": "The agent stopped waiting. Approving still lets its retry through.",
  "pickers": [
    { "id": "duration", "label": "Allow", "default": "7d",
      "options": [ { "id": "once", "label": "Once", "hint": "Runs this one request and remembers nothing." },
                   { "id": "7d", "label": "7 Days", "hint": "…" } ] }
  ],
  "actions": [
    { "id": "deny", "label": "Deny", "role": "deny" },
    { "id": "approve", "label": "Approve", "role": "approve" }
  ],
  "confirm": "Let Claude Code “fix flaky tests” read “GitHub token”"
}
```

- Every field but `title`, `actions` and `confirm` is optional.
- A consumer shows a section kind it does not know by its `label` and `text`,
  if it has them, and otherwise skips it.
- `confirm` is the one line that says what an `approve` action grants. The
  phone's native code shows it, with the chosen options, beside the slide
  control. That native panel is the part of the phone a modified web page
  cannot fake.

## Consumer → provider

```jsonc
{ "type": "reply", "id": "…", "keyId": "…", "statement": "{…}", "signature": "<base64>" }
{ "type": "pair", "publicKey": "<base64>", "name": "iPhone" }
```

### The signed statement

The phone builds the statement and signs its UTF-8 bytes: ECDSA P-256 over
SHA-256, DER-encoded, then base64. The statement is sent as the exact string
that was signed, so nobody has to reproduce a canonical JSON encoding.

```jsonc
{
  "v": 1,
  "provider": "opProxy",
  "id": "…",
  "revision": 2,
  "challenge": "…",            // the item's, verbatim
  "documentSha256": "…",       // lowercase hex SHA-256 of the document string's UTF-8 bytes
  "action": "approve",
  "picks": { "duration": "7d" },
  "keyId": "…",
  "signedAt": 1760000000000
}
```

The provider accepts a reply only if all of these hold:
1. `keyId` is a paired key, and `signature` verifies over `statement` with it.
2. `id` names a pending item, and `challenge` is that item's.
3. `documentSha256` is the hash of a document it published for that item. Any
   revision counts, since a revision only adds context like `notice`.
4. `action` and every pick name an action and an option that document offered.

### Keys

The phone's key is a P-256 key in the iPhone's Secure Enclave, made by the
Spaceterm app and usable only by its native code. `publicKey` is its raw
64-byte X‖Y form, base64. `keyId` is the lowercase hex of the first 16 bytes of
SHA-256(raw public key), and the fingerprint people compare is its first 16 hex
digits in groups of four (`ab12 cd34 ef56 7890`).

Signing needs no Face ID; that is a choice the user made. What keeps a modified
web page from approving on its own is that native code signs an `approve`-role
action only after the slide control in its own panel has been dragged all the
way across.

### Pairing

`pair` asks the provider to trust a key. The provider must have it confirmed by
the user on the Mac itself, showing the fingerprint, and the phone shows the
same fingerprint to compare. opProxy confirms with Touch ID and signs the paired
key with its Secure Enclave approval key, so an agent cannot add a key of its
own.
