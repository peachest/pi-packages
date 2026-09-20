# pi-events-daemon (prototype-events-daemon)

Centralized events daemon pi extension: an entity state-machine substrate. Entities mirror external systems, transitions produce events as byproducts, and sessions subscribe to be woken. This file is the domain vocabulary; the frozen user-facing spec is issue #26, the aggregate design is #29.

## Language

### Entity model

**Entity**:
A durable mirror of one thing in an external system (or a local asset), identified by an EntityRef and carrying a closed-set state plus a payload. The aggregate root of the richest aggregate; its state is a pure reduction of its transition events.
_Avoid_: resource, object, topic (topic is an internal routing key only)

**EntityRef**:
The identity of an entity: a source-system native identifier (GitLab/GitHub page URL, k8s REST URL, image transport ref, local path) under the key prefixes `external/`/`project/`/`user/`. Agents never mint or parse these; key generators do.
_Avoid_: id, uuid, entity-id

**Payload**:
The attributes that explain the entity's *current* state — never history, never bulk text. Its identity fields (digest, metadata.uid, contentHash) drive self-transitions.
_Avoid_: metadata, data, body

**State (enum)**:
A member of the profile-defined closed set of states an entity moves through. Null until the first verdict arrives — there is no synthetic "unprobed" pre-state. Contrast with progress values, which are deliberately not states, and with Delivery state, which is kernel-defined bookkeeping.
_Avoid_: status (collides with the `status()` registration op — a write op; reads go through `query`), phase

**Transition**:
A state change of an entity, committed in the same transaction as exactly one event (invariant I1).

**Self-transition**:
A transition where the state does not change but the content identity does — (state, contentIdentity) is the real pair. A new image digest or changed file content emits an event despite the same state.

**Content identity**:
The payload field whose change alone justifies an event: image digest, file content hash, config revision.

**Ephemeral entity**:
An entity born from one ad-hoc condition, with no external identity (key = daemon-minted sha1 of check + schedule + cwd), retired after reaching a terminal state. Short-lived by design.
_Avoid_: temporary entity, ad-hoc watch

**Persistent entity**:
An entity that mirrors a real external object or long-lived asset and keeps existing even with no subscribers. The default.
_Avoid_: (the unqualified term "entity" covers this; say ephemeral only when the distinction matters)

### Probing and subscribing

**ProbeSpec**:
A value object fully describing how to evaluate one condition against one entity (check command, source, schedule). The check command text is one of its components; the checker is the execution primitive that runs it. Two subscriptions with equal ProbeSpecs share one runner (I5).
_Avoid_: watcher, monitor, poller

**Schedule**:
The time dimension of a ProbeSpec: `{ type: "interval", every: "60s" }` or `{ type: "cron", expr, tz? }` (crontab 5-field, evaluated at tick points, timezone optional defaulting to local). Part of the template asset — agents never set it in subscribe opts (B1); the type enum is the extension point for future cadence forms.
_Avoid_: interval (only one schedule type), polling frequency

**Subscription**:
The aggregate that owns one agent's standing interest in an entity: open/re-arm/cancel lifecycle, per-leg, replaceable by closing and opening a new one when the check changes.
_Avoid_: topic subscription, listener (registration is always through the daemon, never a pub/sub topic surface)

**Runner slot**:
The runtime executor for one fetch key (EntityRef, template) — holds the run ledger and a reference count; created by the first subscription, destroyed when the last closes; not durable (rebuilt on daemon restart from subscriptions).
_Avoid_: worker, probe instance, runner pool

**Delivery**:
One notification's journey to one session, as a single-row aggregate: pending → accepted (session online, retrying) → verified, or parked (session gone, waiting for SESSION_START drain) → verified, with failed / dead-letter exits. Exactly one row per (notification, session) — I10. Its verification is the presence of the deterministic notificationId entry in the session transcript (I9).
_Avoid_: message, push

**Delivery state**:
The kernel-defined fixed closed set of bookkeeping states a delivery moves through — pending | accepted | parked | verified | failed | dead-letter. Not profile-defined, and never produces events (only entity transitions do).
_Avoid_: delivery status

**Notification**:
A value object, not an aggregate: the pushed content for one matched event (deterministic notificationId + billboard view). One notification fans out into many Deliveries.
_Avoid_: notice, alert

### Roles

**Profile**:
The per-entity-type domain knowledge layer: state machine definition, payload schema, key generator (URL parser/canonicalizer), and probe templates. The daemon kernel contains zero domain knowledge.
_Avoid_: plugin, provider, adapter (adapter means the session-locator adapter)

**Session-locator adapter**:
The single module that knows how pi persists sessions (today: JSONL transcripts and `custom_message` entries; future v4: custom agent messages and lane envelopes).

**Checker**:
The shell-level primitive a probe executes to produce a tri-state semantic verdict (pass/fail/in-progress) plus evidence.
_Avoid_: script, command (a checker is always tri-state; exit 2 means assertion-failed terminal)
