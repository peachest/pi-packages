# ADR 0005: Single Bounded Context — kernel owns the language, profiles speak it

Date: 2026-09-18
Status: Accepted (user-confirmed, #29)

## Context

The substrate has three kinds of knowledge: generic event-substrate semantics (transitions, subscriptions, deliveries), per-entity-type domain knowledge (GitLab MR state sets, k8s pod lifecycle, image transports), and pi-session integration (transcript formats). The question: is each profile a bounded context with its own ubiquitous language, or is there one context with module boundaries inside?

## Decision

**pi-events-daemon is a single bounded context.** The kernel owns every core term (Entity, EntityRef, State, Transition, Subscription, ProbeSpec, Delivery, Transitioned); profiles supply State *values* and probe templates but never new concepts. "An MR entity" and "a k8s entity" do not speak two languages — they are two instantiations of one vocabulary.

Module layers inside the context:

| Layer | Role | Language |
|---|---|---|
| kernel | The three aggregates + event/delivery semantics | **owns** the ubiquitous language |
| profile | State machines, payload schemas, key generators, probe templates | borrows kernel language, fills in values |
| session-locator adapter | Transcript format detection (v3/v4/lane envelope/torn tail) | borrows + private technical terms |
| runtime components (probe executor, delivery dispatcher, verification scanner) | Connective tissue, rebuilt on restart | implementation-level, deliberately outside the glossary |

The key generator + probe templates form the **anti-corruption layer** to external contexts (GitLab URL → EntityRef, glab query → tri-state verdict). ADR 0002 (native identity) defines the translation rules.

## Kernel touchstone

**Adding a new profile (e.g., a GitHub source) must require zero kernel changes.** Dependency direction is one-way: profiles import kernel; kernel never imports profiles. If an implementation change to "support a new source system" touches kernel code, that is the backtrack signal that the boundary was drawn wrong.

## Alternatives considered

- **Profile-per-context**: each profile gets its own ubiquitous language ("MR entity" ≠ "pod entity" as distinct concepts). Rejected: #29 rulings already treat profile state sets as *values* of one State concept; per-context languages would fragment CONTEXT.md's single glossary and split the P-014 terminology discipline by context. The cost (translation maps between contexts) buys nothing — profiles genuinely share the substrate language.

## Consequences & risks

- Subdomain classification confirms the boundary: the Core domain (I1 transition-as-event, I5 fetch/predicate separation, origin addressing, parked/drain delivery) coincides with the kernel; profiles, scheduling mechanics (reused from pi-schedule patterns), checker execution surface, adapter, and persistence are Supporting/Generic. Core ≈ kernel is the strategic-layer cross-check.
- Risk: concept leakage — a profile growing its own nouns (e.g., a "review state" vocabulary inside the GitLab profile) instead of mapping to kernel terms. Watch for it in profile review; the touchstone audit catches the structural version.
- ADR 0001-0004 remain in force; this ADR records the strategic boundary they implicitly assumed.
