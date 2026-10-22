import { describe, expect, it } from "vitest";

import { AiGateway, AiRefusal } from "../src/gateway.ts";
import type { EntitlementState } from "../src/host-contract.ts";
import { type ModelRequest, ProviderFailure } from "../src/provider.ts";
import { CALLS_COLLECTION, USAGE_COLLECTION } from "../src/usage.ts";
import {
  answer,
  FakeProvider,
  type StandIn,
  standIn,
  type StandInOptions,
} from "./stand-in-host.ts";

/**
 * The gateway every assistant reaches a model through, against a fake
 * provider: what it checks before a call, what it counts after one, and what
 * an assistant is told when it makes none.
 */

const REQUEST: ModelRequest = {
  system: "Du hjälper styrelsen.",
  messages: [{ role: "user", content: "Sammanfatta ärendet." }],
  maxOutputTokens: 1000,
};

const DISCLOSURE = {
  personalData: ["freeText"],
  subjects: ["person-1"],
} as const;

interface Setup extends StandIn {
  gateway: AiGateway;
  provider: FakeProvider;
  clock: { now: Date };
}

function setup(options: StandInOptions & { now?: string } = {}): Setup {
  const stand = standIn(options);
  const provider = new FakeProvider();
  const clock = { now: new Date(options.now ?? "2026-10-22T09:41:12Z") };
  const gateway = new AiGateway(stand.host, {
    // The own-key route's rule, with the fake in Anthropic's place.
    route: (settings) => (settings.apiKey === null ? null : provider),
    now: () => clock.now,
  });
  return { ...stand, gateway, provider, clock };
}

async function refusal(promise: Promise<unknown>): Promise<AiRefusal> {
  const error = await promise.then(
    () => {
      throw new Error("The call was not refused.");
    },
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(AiRefusal);
  return error as AiRefusal;
}

describe("a call within every limit", () => {
  it("reaches the provider with the request and the disclosure, and answers", async () => {
    const { gateway, provider } = setup();

    const response = await gateway.complete(REQUEST, DISCLOSURE);

    expect(response.message.content).toEqual([
      { type: "text", text: "Ett utkast." },
    ]);
    expect(provider.calls).toEqual([
      { request: REQUEST, disclosure: DISCLOSURE },
    ]);
  });

  it("passes a request that carries no personal data with a null disclosure", async () => {
    const { gateway, provider } = setup();

    await gateway.complete(REQUEST, null);

    expect(provider.calls[0]?.disclosure).toBeNull();
  });

  it("counts what the call used towards the month, in the Stockholm month", async () => {
    // 23:30 UTC on 31 October is already November in Stockholm.
    const { gateway, provider, records } = setup({
      now: "2026-10-31T23:30:00Z",
    });
    provider.answers.push(
      answer({
        inputTokens: 300,
        outputTokens: 50,
        cacheReadTokens: 7,
        cacheWriteTokens: 3,
      }),
    );

    await gateway.complete(REQUEST, null);

    expect(records.value(USAGE_COLLECTION, "month:2026-11")).toMatchObject({
      inputTokens: 300,
      outputTokens: 50,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
      calls: 1,
    });
    expect(records.value(USAGE_COLLECTION, "month:2026-10")).toBeUndefined();
    // Added to the month's totals, so the call's own record is gone.
    expect(records.keys(CALLS_COLLECTION)).toEqual([]);
  });

  it("reads the settings on every call, so a key the board clears bites at once", async () => {
    const { gateway, provider, settings } = setup();
    await gateway.complete(REQUEST, null);

    settings.apiKey = "";
    const refused = await refusal(gateway.complete(REQUEST, null));

    expect(refused.reason).toBe("provider-not-configured");
    expect(provider.calls).toHaveLength(1);
  });

  it("refuses an answer limit no model allows, as the caller's defect", async () => {
    const { gateway, provider } = setup();

    for (const maxOutputTokens of [0, -1, 1.5, 128_001, Number.NaN]) {
      await expect(
        gateway.complete({ ...REQUEST, maxOutputTokens }, null),
      ).rejects.toThrow(RangeError);
    }
    expect(provider.calls).toHaveLength(0);
  });
});

describe("what the gateway checks before a call", () => {
  it.each(["recipients", "records", "entitlements"] as const)(
    "makes no call on a host without %s",
    async (member) => {
      const { gateway, provider } = setup({ without: [member] });

      const refused = await refusal(gateway.complete(REQUEST, null));

      expect(refused.reason).toBe("host-unsupported");
      expect(provider.calls).toHaveLength(0);
    },
  );

  const NOT_ACTIVE: EntitlementState[] = [
    { status: "absent" },
    { status: "expired", licenceId: "lic-1", validUntil: "2026-09-30" },
    {
      status: "version-not-covered",
      licenceId: "lic-1",
      updatesUntil: "2026-01-01",
      released: "2026-10-22",
    },
    { status: "wrong-instance", licenceId: "lic-1" },
    { status: "tampered" },
    { status: "not-yet-valid", licenceId: "lic-1", issuedOn: "2027-01-01" },
  ];

  it.each(NOT_ACTIVE)(
    "makes no call without an active licence ($status)",
    async (entitlement) => {
      const { gateway, provider } = setup({ entitlement });

      const refused = await refusal(gateway.complete(REQUEST, null));

      expect(refused.reason).toBe("entitlement-required");
      expect(refused.message).not.toContain("lic-1");
      expect(provider.calls).toHaveLength(0);
    },
  );

  it.each([undefined, "", "   "])(
    "makes no call without a key (%j)",
    async (apiKey) => {
      const { gateway, provider } = setup({ settings: { apiKey } });

      const refused = await refusal(gateway.complete(REQUEST, null));

      expect(refused.reason).toBe("provider-not-configured");
      expect(provider.calls).toHaveLength(0);
    },
  );

  it("checks the licence before the key, so an unlicensed instance is told about the licence", async () => {
    const { gateway } = setup({
      entitlement: { status: "absent" },
      settings: { apiKey: "" },
    });

    expect((await refusal(gateway.complete(REQUEST, null))).reason).toBe(
      "entitlement-required",
    );
  });
});

describe("the monthly limit", () => {
  it("stops calls once the month's tokens reach the limit, and starts again next month", async () => {
    const { gateway, provider, clock } = setup({
      settings: { monthlyTokenLimit: 250 },
    });
    provider.answers.push(answer({ inputTokens: 100, outputTokens: 20 }));
    provider.answers.push(answer({ inputTokens: 100, outputTokens: 30 }));

    await gateway.complete(REQUEST, null);
    // 120 used: under the limit, so this one goes ahead and takes it to 250.
    await gateway.complete(REQUEST, null);
    const refused = await refusal(gateway.complete(REQUEST, null));

    expect(refused.reason).toBe("usage-limit-reached");
    expect(provider.calls).toHaveLength(2);

    clock.now = new Date("2026-11-01T00:00:00+01:00");
    await gateway.complete(REQUEST, null);
    expect(provider.calls).toHaveLength(3);
  });

  it("stops every call with a limit of 0", async () => {
    const { gateway, provider } = setup({
      settings: { monthlyTokenLimit: 0 },
    });

    expect((await refusal(gateway.complete(REQUEST, null))).reason).toBe(
      "usage-limit-reached",
    );
    expect(provider.calls).toHaveLength(0);
  });

  it("counts every one of many calls finishing at once", async () => {
    const { gateway, records } = setup({
      settings: { requestsPerMinute: 120 },
    });

    await Promise.all(
      Array.from({ length: 6 }, () => gateway.complete(REQUEST, null)),
    );

    expect(records.value(USAGE_COLLECTION, "month:2026-10")).toMatchObject({
      inputTokens: 600,
      outputTokens: 120,
      calls: 6,
    });
  });

  it("counts every call when more finish at once than a write has attempts", async () => {
    // The default 10 calls a minute, each admitted before the next arrives,
    // and all ten answered together: ten writers for one month's totals,
    // more than the eight attempts each makes.
    const { gateway, provider, records, clock, logged } = setup();
    let release = (): void => undefined;
    provider.gate = new Promise((resolve) => {
      release = resolve;
    });
    const calls: Promise<unknown>[] = [];
    for (let admitted = 1; admitted <= 10; admitted++) {
      calls.push(gateway.complete(REQUEST, null));
      while (provider.calls.length < admitted) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    release();
    await Promise.all(calls);

    expect((await gateway.status()).usage).toEqual({
      month: "2026-10",
      tokens: 1200,
      calls: 10,
    });
    expect(logged.filter((each) => each.level !== "info")).toEqual([]);

    // The next call adds any call the others left to it.
    provider.gate = null;
    clock.now = new Date("2026-10-22T09:42:00Z");
    await gateway.complete(REQUEST, null);
    expect(records.value(USAGE_COLLECTION, "month:2026-10")).toMatchObject({
      inputTokens: 1100,
      outputTokens: 220,
      calls: 11,
    });
    expect(records.keys(CALLS_COLLECTION)).toEqual([]);
  });

  it("reads a month record it cannot make sense of as nothing used", async () => {
    const { gateway, records, provider } = setup();
    await records.put(USAGE_COLLECTION, "month:2026-10", {
      inputTokens: "a lot",
      calls: -1,
    });

    await gateway.complete(REQUEST, null);

    expect(provider.calls).toHaveLength(1);
    expect(records.value(USAGE_COLLECTION, "month:2026-10")).toMatchObject({
      inputTokens: 100,
      calls: 1,
    });
  });
});

describe("the per-minute limit", () => {
  it("refuses a call past the limit until the next minute, saying when", async () => {
    const { gateway, provider, clock } = setup({
      settings: { requestsPerMinute: 2 },
    });

    await gateway.complete(REQUEST, null);
    await gateway.complete(REQUEST, null);
    const refused = await refusal(gateway.complete(REQUEST, null));

    expect(refused.reason).toBe("rate-limited");
    // 09:41:12, so the next minute starts in 48 seconds.
    expect(refused.retryAfterSeconds).toBe(48);
    expect(provider.calls).toHaveLength(2);

    clock.now = new Date("2026-10-22T09:42:00Z");
    await gateway.complete(REQUEST, null);
    expect(provider.calls).toHaveLength(3);
  });

  it("admits no more than the limit when many calls arrive at once", async () => {
    const { gateway, provider } = setup({
      settings: { requestsPerMinute: 3 },
    });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () => gateway.complete(REQUEST, null)),
    );

    expect(outcomes.filter((each) => each.status === "fulfilled")).toHaveLength(
      3,
    );
    expect(provider.calls).toHaveLength(3);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject({ reason: "rate-limited" });
      }
    }
  });
});

describe("the per-minute limit under contention", () => {
  it("admits every caller below the limit, however many write at once", async () => {
    // More callers than the eight writes a conflict was once retried: one
    // wins each round, so the last loses more than eight times.
    const { gateway, provider } = setup({
      settings: { requestsPerMinute: 30 },
    });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 24 }, () => gateway.complete(REQUEST, null)),
    );

    expect(outcomes.map((each) => each.status)).toEqual(
      Array(24).fill("fulfilled"),
    );
    expect(provider.calls).toHaveLength(24);
  });
});

describe("a provider that gives no answer", () => {
  it("is refused as provider-failed with its reason, and logged without what was sent", async () => {
    const { gateway, provider, logged } = setup();
    provider.answers.push(new ProviderFailure("unauthorised", 401));

    const refused = await refusal(gateway.complete(REQUEST, DISCLOSURE));

    expect(refused.reason).toBe("provider-failed");
    expect(refused.providerReason).toBe("unauthorised");
    expect(logged).toEqual([
      {
        level: "warn",
        message: "Fake gave no answer: unauthorised (HTTP 401).",
      },
    ]);
  });

  it("passes on the provider's own rate limit with its wait", async () => {
    const { gateway, provider } = setup();
    provider.answers.push(new ProviderFailure("rate-limited", 429, 30));

    const refused = await refusal(gateway.complete(REQUEST, null));

    expect(refused.reason).toBe("rate-limited");
    expect(refused.retryAfterSeconds).toBe(30);
    expect(refused.providerReason).toBe("rate-limited");
  });

  it("counts what an unreadable answer used all the same", async () => {
    const { gateway, provider, records } = setup();
    provider.answers.push(
      new ProviderFailure("bad-response", 200, null, {
        inputTokens: 40,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    );

    await refusal(gateway.complete(REQUEST, null));

    expect(records.value(USAGE_COLLECTION, "month:2026-10")).toMatchObject({
      inputTokens: 40,
      outputTokens: 5,
      calls: 1,
    });
  });

  it("lets anything that is not a provider's failure through as it is", async () => {
    const { gateway, provider } = setup();
    const fault = new Error("address-refused");
    provider.answers.push(fault);

    await expect(gateway.complete(REQUEST, null)).rejects.toBe(fault);
  });
});

describe("the board's status", () => {
  it("shows the licence, the provider, the key's presence and the month's use", async () => {
    const { gateway, provider } = setup({
      settings: { monthlyTokenLimit: 50_000, requestsPerMinute: 5 },
    });
    provider.answers.push(answer({ inputTokens: 900, outputTokens: 100 }));
    await gateway.complete(REQUEST, null);

    expect(await gateway.status()).toEqual({
      hostSupported: true,
      licence: {
        status: "active",
        licenceId: "lic-1",
        validUntil: "2027-11-30",
        updatesUntil: null,
      },
      provider: { name: "Fake", model: "fake-model", keyEntered: true },
      usage: { month: "2026-10", tokens: 1000, calls: 1 },
      monthlyTokenLimit: 50_000,
      requestsPerMinute: 5,
    });
  });

  it("never carries the key", async () => {
    const { gateway } = setup();

    expect(JSON.stringify(await gateway.status())).not.toContain(
      "sk-ant-test-key",
    );
  });

  it("says a host older than the package is not supported", async () => {
    const { gateway } = setup({
      without: ["records"],
      settings: { apiKey: "" },
    });

    expect(await gateway.status()).toMatchObject({
      hostSupported: false,
      usage: null,
      provider: { keyEntered: false },
    });
  });
});
