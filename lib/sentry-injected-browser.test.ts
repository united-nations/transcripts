import { describe, expect, it } from "vitest";
import { shouldDropClientEvent } from "./sentry-filter";

const page = { filename: "app:///en/login", function: "global code" };
const bridge = {
  filename: "app://navigation_performance_logger_android",
  function: "sendDataToNative",
};
const app = { filename: "app:///lib/hooks/use-timezone.tsx", function: "read" };
const signatures = [
  ["ReferenceError", "Can't find variable: __firefox__", page],
  [
    "TypeError",
    "undefined is not an object (evaluating 'window.__firefox__.reader')",
    page,
  ],
  [
    "TypeError",
    "undefined is not an object (evaluating 'window.__firefox__.refresh_youtube_quality_C85C5288CC2B4BDCBB20C5778007F667')",
    page,
  ],
  [
    "Error",
    "MetaMask extension not found",
    { filename: "app:///scripts/inpage.js" },
  ],
  [
    "i",
    "Failed to connect to MetaMask",
    { filename: "app:///scripts/inpage.js" },
  ],
  ["Error", "Error invoking postMessage: Java object is gone", bridge],
] as const;

function exception(type: string, value: string, frame = app) {
  return { type, value, stacktrace: { frames: [frame] } };
}

describe("confirmed injected browser signatures", () => {
  it.each(signatures)(
    "drops %s: %s only at its external source",
    (type, value, frame) => {
      const error = { type, value, stacktrace: { frames: [frame] } };
      expect(shouldDropClientEvent({ exception: { values: [error] } })).toBe(
        true,
      );
    },
  );

  it.each(signatures)("retains %s: %s from application code", (type, value) => {
    expect(
      shouldDropClientEvent({
        exception: { values: [exception(type, value)] },
      }),
    ).toBe(false);
  });

  it("retains application callers in a native logger stack", () => {
    const error = exception("Error", signatures[5][1], bridge);
    error.stacktrace.frames.unshift(app);
    expect(shouldDropClientEvent({ exception: { values: [error] } })).toBe(
      false,
    );
  });

  it("drops the captured multi-frame native logger signature", () => {
    const frames = ["sendINPMessage", "sendDataToNative"].map((name) => ({
      filename: bridge.filename,
      function: name,
    }));
    const error = {
      type: "Error",
      value: signatures[5][1],
      stacktrace: { frames },
    };
    expect(shouldDropClientEvent({ exception: { values: [error] } })).toBe(
      true,
    );
  });

  it("retains a chain containing an application failure", () => {
    const external = exception("Error", signatures[5][1], bridge);
    const firstParty = exception(
      "TypeError",
      "Cannot read properties of undefined (reading 'name')",
    );
    expect(
      shouldDropClientEvent({ exception: { values: [external, firstParty] } }),
    ).toBe(false);
  });

  it.each([
    "Cannot read properties of undefined (reading 'M_ID')",
    "Failed to fetch",
    "The operation is insecure.",
    "Object captured as promise rejection with keys: category, code, data, severity",
    "This operation was aborted",
    "controller[kState].transformAlgorithm is not a function",
  ])("retains unconfirmed or actionable failure: %s", (value) => {
    expect(
      shouldDropClientEvent({
        exception: { values: [exception("Error", value)] },
      }),
    ).toBe(false);
  });

  it("does not classify stackless errors or unrelated bridge errors as injection", () => {
    const value = signatures[5][1];
    expect(
      shouldDropClientEvent({
        exception: { values: [{ type: "Error", value }] },
      }),
    ).toBe(false);
    expect(
      shouldDropClientEvent({
        exception: {
          values: [exception("Error", "Unexpected response", bridge)],
        },
      }),
    ).toBe(false);
  });
});
