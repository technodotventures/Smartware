# Smartware Schemas v0.4.2

These Draft 2020-12 JSON Schemas are the normative beta schema set paired with
Smartware Protocol v0.4.2 and Spec v1.6.16.

Each schema has a versioned `$id`. Only this set may be used to claim v0.4.2
schema conformance.

`integrity-manifest-entry.schema.json` describes an optional post-beta surface.
Its presence does not make the integrity manifest a beta requirement.

Canonical relation schemas intentionally reject `origin: model` and
`origin: reviewed`: model output is a derived candidate, and delegated reviewed
admission is post-beta. In beta, epistemic edges are user-admitted; autonomous
canonical writes are limited to deterministically verified `references`.

The repository schema test compiles every file with AJV 2020 and exercises
positive and negative fixtures for claim protection, relation admission,
REVISE, and context bundles.

## Delivery-planning profile

The implementation exports optional Layer 4 helpers for conservative retrieval
admission and lane-aware token packing. They are wire-neutral and do not add
properties to these frozen v0.4.2 schemas. Consumer adapters may expose the
decision and packing telemetry in their own versioned response envelope.

Terminal `reflect.auto` observation receipts fit the existing open `details`
object in `operation-log-entry.schema.json`; their exact content-free shape and
outcomes are specified in the protocol document.
