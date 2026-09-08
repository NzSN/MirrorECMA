# Dynamic binding type coverage and lifecycle

Date: 2026-09-06

Status: Implemented; targeted validation recorded in the implementation plan.

## Problem and outcome

Dynamic descriptor mode previously rejected `opaqueItf`, although the Mirrors
client guide MI17 requires every descriptor type. Its registry was supplied as
already constructed callbacks, so callers could construct their SUT before
negotiation. Synchronous callbacks also excluded implementations that await I/O,
and disposal did not prevent later calls to the binding.

The completed design makes opaque protocol data representable, adds a deferred
registry factory, and gives asynchronous local callbacks an explicit lifecycle.
Application code remains local. Neither descriptor descriptions nor other
descriptor fields are interpreted as executable code.

## Contract boundaries

- MI8: validate the full descriptor reply, identity, and requested policy before
  calling the registry factory or constructing its SUT.
- MI17: validate exact initializer/action/observer IDs and digest, project and
  validate every input before mutation, map wire aliases to primary action IDs,
  perform one observation pass after each successful action, and permanently
  poison the binding after invalid observations.
- The descriptor algebra includes `opaqueItf`; the portable generated MITL v1
  emitter still rejects it. This change belongs to the dynamic interpreter and
  does not change compiler locks, generated profiles, or wire encodings.
- Existing synchronous `StateComputer`, message types, and synchronous handler
  signatures remain unchanged. A narrow record-key correction in
  `src/protocol.ts` is required to preserve opaque values on the wire.

## Opaque native representation

`OpaqueItfValue` is a class with a private runtime brand. Applications construct
one using `opaqueItfValue(value)` or its validating constructor and inspect its
deeply readonly `value`. Dynamic input decoding constructs the same wrapper.
Dynamic observation encoding only accepts a genuinely branded instance; a cast,
ordinary `{ tag, value }` variant, record, or forged prototype is insufficient.
The wrapper is also excluded from ordinary native record and variant encoding.

Construction validates and copies the entire protocol `Value` tree, recursively
freezes every object and array, and retains no aliases to caller-owned mutable
data. All existing `Value` tags are supported, including `unserializable` as
inert string data. Record labels such as `__proto__` remain ordinary data through
null-prototype output dictionaries.

The protocol codec previously assigned record/state labels into ordinary objects
with `object[key] = value`. For `__proto__`, this invoked the inherited setter,
changed the temporary object's prototype, and omitted the field from serialized
or decoded data. Encoding states, encoding records, and decoding records now
define own enumerable, writable, configurable data properties instead. Output
objects retain `Object.prototype`, ordinary field ordering and bytes are
unchanged, and `__proto__`, `constructor`, and `prototype` remain plain labels
through an actual `encodeState` → JSON → `decodeMirrorMessage` roundtrip. This
is a value-fidelity fix, not a protocol schema or message change.

Only plain objects with own enumerable string data properties and dense plain
arrays are accepted. Unknown tags, wrong primitive types, additional fields,
accessors, symbol fields, nonplain prototypes, malformed map pairs, cycles,
duplicate set elements, and duplicate map keys are rejected. Equality is
canonical: record field order and set/map iteration order do not distinguish
values, but sequence order and protocol tags do.

Each projected input or opaque wrapper permits at most 64 nested value edges
and 10,000 value nodes. The same validation precedes collection-key comparison,
so deeply nested or malformed opaque keys cannot bypass limits by appearing in
a typed outer set or map. The limits bound value structure, not UTF-8 message
size; transport framing retains its separate byte limit.

Opaque values can occur directly, inside every supported container, and in both
map keys and values. A wrapper snapshots at construction; callers observing
mutable SUT data should construct a fresh wrapper for each observation.

## Asynchronous execution

The additive `bindAsyncDynamicDescriptor` accepts `AsyncDynamicHandlerRegistry`.
Its action handlers receive `(inputs, context)` and return `void | Promise<void>`;
its observation handlers receive `context` and return a native value or promise.
`context` is the shared replay `ReplayContext`: a signal and trace/state position.
The binding exposes an `AsyncStateComputer` while preserving digest, config,
coverage, and disposal methods.

Execution is strictly ordered:

1. Check disposed/poisoned/reentrant state and cancellation.
2. Resolve the primary action and validate every projected input.
3. Await the action handler to finish successfully with `undefined`.
4. Await each observer once in descriptor order.
5. Validate/encode the collected observations and increment primary-ID coverage.

Cancellation is checked before and after each asynchronous boundary and before
state return. The runner implements deadlines by aborting the per-call signal;
the binder reacts identically to caller cancellation and deadline cancellation.
Binding disposal also aborts the signal received by active application callbacks.

An action, observer, projection, encoding, cancellation, or reentrancy failure
permanently poisons the binding. A concurrent/reentrant call also aborts the
pending invocation, so swallowing its error cannot revive the original call.
After cancellation, late promise completion/rejection is consumed without
starting more observers, incrementing coverage, or returning a state. JavaScript
cannot forcibly stop non-cooperative code: its own external mutations can still
finish. This API does not promise rollback or undo.

The existing synchronous binder continues to reject all thenables. Both binders
reject computation immediately after disposal begins, and repeated disposal
calls share one promise and invoke cleanup once. If cleanup fails, later disposal
calls observe the same failure rather than invoking cleanup again.

## Deferred factory and ownership

Negotiated selection gains a factory-backed dynamic alternative with an exact
semantic digest, contract, and `createRegistry(config, descriptor)` callback.
The returned scope discriminates synchronous from asynchronous execution and
contains its registry plus optional `dispose` callback. Existing preconstructed
registry selection remains available for compatibility.

The runner calls the factory only after successful negotiation. It owns the
returned scope until binder validation succeeds; digest/ID/config failures must
dispose that scope exactly once. After successful construction, binding disposal
owns scope cleanup. Primary negotiation/replay errors retain priority over
cleanup failures. Asynchronous factory cancellation requires disposing a scope
that arrives late without starting its binding.

## Verification

Tests exercise all descriptor types, nested opaque data in each container,
canonical duplicate keys, mutation alias isolation, malformed objects without
getter invocation, excessive/cyclic data, forged wrappers, aliases, and disposal.
Controlled promises establish asynchronous ordering, failure poisoning,
pre-aborted contexts, cancellation/timeouts, ignored cancellation, late rejection,
reentrancy, and disposal while an invocation remains pending. Negotiated-runner
tests own factory timing, scope cleanup on construction failure, and absence of
post-cancellation `report_state` messages.
