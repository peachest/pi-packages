# pi-events-daemon (prototype-events-daemon)

Centralized events daemon pi extension: an entity state-machine substrate. Entities mirror external systems, transitions produce events as byproducts, and sessions subscribe to be woken. This file is the domain vocabulary; the frozen user-facing spec is issue #26, the aggregate design is #29.

## Language

### Entity model

**Entity**:
A durable mirror of one thing in an external system (or a local asset), identified by an EntityRef and carrying a closed-set state plus a payload. The aggregate root of the richest aggregate; its state is a pure reduction of its transition events.
_Avoid_: resource, object, topic (topic is an internal routing key only)

**EntityRef**:
The identity of an entity: a source-system native identifier (GitLab/GitHub page URL, k8s REST URL, image transport ref, local path) under the key prefixes `ext/`/`p/`/`u/` (external / project / user scopes). Agents never mint or parse these; key generators do.
_Avoid_: id, uuid, entity-id

**Payload**:
The attributes that explain the entity's *current* state — never history, never bulk text. Its identity fields (digest, metadata.uid, contentHash) drive self-transitions.
_Avoid_: metadata, data, body

**State (enum)**:
A member of the profile-defined closed set of states an entity moves through. Contrast with progress values, which are deliberately not states.
_Avoid_: status (reserved for the `status()` query op), phase

**Transition**:
A state change of an entity, committed in the same transaction as exactly one event (invariant I1).

**Self-transition**:
A transition where the state does not change but the content identity does — (state, contentIdentity) is the real pair. A new image digest or changed file content emits an event despite the same state.

**Content identity**:
The payload field whose change alone justifies an event: image digest, file content hash, config revision.

**Ephemeral entity**:
An entity born from one ad-hoc condition, with no external identity (key = daemon-minted sha1 of the check), retired after reaching a terminal state. Short-lived by design.
_Avoid_: temporary entity, ad-hoc watch

**Persistent entity**:
An entity that mirrors a real external object or long-lived asset and keeps existing even with no subscribers. The default.
_Avoid_: (the unqualified term "entity" covers this; say ephemeral only when the distinction matters)

### Probing and subscribing

**ProbeSpec**:
A value object fully describing how to evaluate one condition against one entity (check command, source, interval). Two subscriptions with equal ProbeSpecs share one runner (I5).
_Avoid_: watcher, monitor, poller

**Subscription**:
The aggregate that owns one agent's standing interest in an entity: open/re-arm/close lifecycle, per-leg, replaceable by closing and opening a new one when the check changes.
_Avoid_: topic subscription, listener (registration is always through the daemon, never a pub/sub topic surface)

**Delivery**:
One notification's journey to one session: pending → accepted → verified (or dead-letter). Exactly one row per (notification, session) — I10. Its verification is the presence of the deterministic notificationId entry in the session transcript (I9).
_Avoid_: message, push, notification (a notification fans out to many deliveries)

### Roles

**Profile**:
The per-entity-type domain knowledge layer: state machine definition, payload schema, key generator (URL parser/canonicalizer), and probe templates. The daemon kernel contains zero domain knowledge.
_Avoid_: plugin, provider, adapter (adapter means the session-locator adapter)

**Session-locator adapter**:
The single module that knows how pi persists sessions (today: JSONL transcripts and `custom_message` entries; future v4: custom agent messages and lane envelopes).

**Checker**:
The shell-level primitive a probe executes to produce a tri-state semantic verdict (pass/fail/in-progress) plus evidence.
_Avoid_: script, command (a checker is always tri-state; exit 2 means assertion-failed terminal)
