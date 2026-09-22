import { createHash } from "node:crypto";

const definitions = Object.freeze({
  "persisted-queue-json/v1": Object.freeze({
    schema: "mirrorecma.independent-probe/v1",
    id: "persisted-queue-json/v1",
    source: "queue.json",
    facts: ["pending", "inFlight", "completed", "failed"],
  }),
  "transfer-payload-journal/v1": Object.freeze({
    schema: "mirrorecma.independent-probe/v1",
    id: "transfer-payload-journal/v1",
    source: "payload+journal.json",
    facts: ["journal", "payload"],
  }),
  "lease-ownership-token-writes/v1": Object.freeze({
    schema: "mirrorecma.independent-probe/v1",
    id: "lease-ownership-token-writes/v1",
    source: "service-private-fields",
    facts: ["owners", "epoch", "expires", "now", "accepted", "writes"],
  }),
});

function normalize(value) {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Set)
    return [...value]
      .map(normalize)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])]),
    );
  return value;
}
function canonical(value) {
  return JSON.stringify(normalize(value));
}

const bigint = (value) => ({ $bigint: String(value) });

export function assertApplicationProbeFidelity(application, facts, reported) {
  if (reported === undefined)
    return Object.freeze({
      status: "error",
      code: "reported_observation_unavailable",
      facts,
    });
  let projected;
  if (application === "work-queue") {
    projected = {
      Pending: facts.pending.map(bigint),
      InFlight: bigint(facts.inFlight),
      Completed: facts.completed
        .map(bigint)
        .sort((left, right) => left.$bigint.localeCompare(right.$bigint)),
      Failed: facts.failed,
    };
  } else if (application === "persistent-transfer") {
    projected = {
      Session: bigint(facts.journal.session),
      Phase: facts.journal.phase,
      Data: facts.payload.map(bigint),
      Committed: facts.journal.committed,
      Accepted: facts.journal.accepted,
    };
  } else if (application === "lease-service") {
    projected = {
      Owners: [...facts.owners].sort((left, right) =>
        canonical(left).localeCompare(canonical(right)),
      ),
      Epoch: facts.epoch,
      Expires: facts.expires,
      Now: facts.now,
      Accepted: facts.accepted,
      Writes: facts.writes,
    };
  } else {
    return Object.freeze({
      status: "error",
      code: "probe_application_unsupported",
      facts,
    });
  }
  return Object.freeze(
    canonical(projected) === canonical(reported)
      ? { status: "passed", facts }
      : {
          status: "failed",
          code: "probe_observer_divergence",
          facts,
        },
  );
}

export function instrumentApplicationAdapter(
  application,
  adapter,
  options = {},
) {
  const budgetMs = options.budgetMs ?? 1_000;
  const enforce = options.enforce === true;
  let last;
  let failure;
  const observe = adapter.observe.bind(adapter);
  const checked = {
    ...adapter,
    observe: async (...args) => {
      const reported = await observe(...args);
      const captured = await captureIndependentProbe(adapter.trustedProbe, {
        budgetMs,
      });
      last =
        captured.status === "passed"
          ? assertApplicationProbeFidelity(
              application,
              captured.facts,
              reported,
            )
          : captured;
      if (last.status !== "passed" && failure === undefined) failure = last;
      if (enforce && last.status !== "passed")
        throw Object.assign(
          new Error("independent probe disagrees with observer"),
          {
            code: last.code ?? "probe_fidelity_failed",
          },
        );
      return reported;
    },
  };
  return Object.freeze({
    adapter: checked,
    result: async () => {
      if (last === undefined)
        last = await captureIndependentProbe(adapter.trustedProbe, {
          budgetMs,
        });
      return failure ?? last;
    },
  });
}

export const probeDefinitions = Object.freeze(
  Object.fromEntries(
    Object.entries(definitions).map(([id, definition]) => [
      id,
      Object.freeze({
        ...definition,
        sha256: createHash("sha256")
          .update(canonical(definition))
          .digest("hex"),
      }),
    ]),
  ),
);

export function withObserverControl(adapter, control, shadowSnapshots = []) {
  if (!["throws", "invalid", "shadow"].includes(control))
    throw new TypeError("unknown observer control");
  let index = 0;
  return Object.freeze({
    ...adapter,
    observe:
      control === "throws"
        ? async () => {
            throw Object.assign(new Error("injected observer failure"), {
              code: "observer_control_failure",
            });
          }
        : control === "invalid"
          ? async () => Object.freeze({ __invalidObservation: true })
          : async () => {
              if (index >= shadowSnapshots.length)
                throw new Error("shadow observer exhausted");
              return shadowSnapshots[index++];
            },
  });
}

export async function captureIndependentProbe(probe, options = {}) {
  if (typeof probe !== "function")
    return Object.freeze({ status: "error", code: "probe_unavailable" });
  const budgetMs = options.budgetMs ?? 1_000;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 0x7fffffff)
    throw new TypeError("invalid probe budget");
  if (options.signal?.aborted)
    return Object.freeze({ status: "error", code: "probe_cancelled" });
  let timer;
  const controller = new AbortController();
  const forward = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forward, { once: true });
  const pending = Promise.resolve().then(() => probe(controller.signal));
  void pending.catch(() => {});
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort("probe timeout");
      resolve({ timedOut: true });
    }, budgetMs);
  });
  try {
    const settled = await Promise.race([
      pending.then((facts) => ({ facts })),
      timeout,
    ]);
    if (settled.timedOut)
      return Object.freeze({ status: "timed_out", code: "probe_timeout" });
    return Object.freeze({ status: "passed", facts: normalize(settled.facts) });
  } catch {
    return Object.freeze({ status: "error", code: "probe_failed" });
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", forward);
  }
}

export async function runIndependentProbe(probe, expected, options = {}) {
  const captured = await captureIndependentProbe(probe, options);
  if (captured.status !== "passed") return captured;
  return Object.freeze(
    canonical(captured.facts) === canonical(expected)
      ? captured
      : { status: "failed", code: "probe_mismatch", facts: captured.facts },
  );
}
