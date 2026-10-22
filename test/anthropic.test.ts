import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_VERSION,
  anthropicProvider,
  MODEL_PROVIDER_RECIPIENT,
} from "../src/anthropic.ts";
import { ownKeyRoute } from "../src/gateway.ts";
import type { PluginRecipients } from "../src/host-contract.ts";
import {
  type ModelCall,
  ProviderFailure,
  type ModelRequest,
} from "../src/provider.ts";
import { aiSettings } from "../src/settings.ts";
import { StandInRecipients } from "./stand-in-host.ts";

/**
 * The own-key route to Anthropic's Messages API, against a stand-in for the
 * host's way out: what it sends, and how it reads what comes back.
 */

const KEY = "sk-ant-test-key";

const REQUEST: ModelRequest = {
  system: "Du hjälper styrelsen.",
  messages: [{ role: "user", content: "Sammanfatta ärendet." }],
  maxOutputTokens: 2000,
};

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig-1" },
      { type: "text", text: "Ett utkast." },
    ],
    stop_reason: "end_turn",
    stop_details: null,
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
    ...overrides,
  };
}

function setup(
  model: "claude-opus-5-5" | "claude-haiku-5-5" = "claude-opus-5-5",
) {
  const recipients = new StandInRecipients();
  const provider = anthropicProvider(
    recipients as PluginRecipients,
    KEY,
    model,
  );
  return { recipients, provider };
}

function call(overrides: Partial<ModelCall> = {}): ModelCall {
  return { request: REQUEST, disclosure: null, ...overrides };
}

function sentBody(
  recipients: StandInRecipients,
  index = 0,
): Record<string, unknown> {
  return JSON.parse(recipients.sent[index]?.init?.body as string) as Record<
    string,
    unknown
  >;
}

async function failure(promise: Promise<unknown>): Promise<ProviderFailure> {
  const error = await promise.then(
    () => {
      throw new Error("The call did not fail.");
    },
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(ProviderFailure);
  return error as ProviderFailure;
}

describe("what is sent", () => {
  it("goes to the declared recipient's Messages API with the association's key", async () => {
    const { recipients, provider } = setup();
    recipients.answer(200, message());

    await provider.complete(call());

    expect(recipients.sent).toHaveLength(1);
    const [sent] = recipients.sent;
    expect(sent?.id).toBe(MODEL_PROVIDER_RECIPIENT);
    expect(sent?.path).toBe("/v1/messages");
    expect(sent?.init).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      timeoutMs: 120_000,
    });
    expect(sentBody(recipients)).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 2000,
      system: "Du hjälper styrelsen.",
      messages: [{ role: "user", content: "Sammanfatta ärendet." }],
      fallbacks: "default",
    });
  });

  it("names the personal data the request carries, and whom it is about, to the host", async () => {
    const { recipients, provider } = setup();
    recipients.answer(200, message());
    const disclosure = {
      personalData: ["name", "freeText"],
      subjects: ["person-1", "person-2"],
    } as const;

    await provider.complete(call({ disclosure }));

    expect(recipients.sent[0]?.init?.disclosure).toEqual(disclosure);
  });

  it("names no disclosure for a request that carries no personal data", async () => {
    const { recipients, provider } = setup();
    recipients.answer(200, message());

    await provider.complete(call());

    expect(recipients.sent[0]?.init).not.toHaveProperty("disclosure");
  });

  it("asks for no fallback on Claude Haiku 5.5, which has none", async () => {
    const { recipients, provider } = setup("claude-haiku-5-5");
    recipients.answer(200, message());

    await provider.complete(call());

    expect(recipients.sent[0]?.init?.headers).not.toHaveProperty(
      "anthropic-beta",
    );
    expect(sentBody(recipients)).not.toHaveProperty("fallbacks");
    expect(sentBody(recipients).model).toBe("claude-haiku-5-5");
  });

  it("sends tools, effort and a conversation with tool results in the API's shapes", async () => {
    const { recipients, provider } = setup();
    recipients.answer(200, message());

    await provider.complete(
      call({
        request: {
          ...REQUEST,
          effort: "low",
          tools: [
            {
              name: "news_read",
              description: "Reads the association's news.",
              inputSchema: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
              },
            },
          ],
          messages: [
            { role: "user", content: "Vad hände senast?" },
            {
              role: "assistant",
              content: [
                { type: "text", text: "Jag läser nyheterna." },
                {
                  type: "tool_use",
                  id: "tu_1",
                  name: "news_read",
                  input: { id: "n1" },
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  toolUseId: "tu_1",
                  content: "{}",
                  isError: true,
                },
              ],
            },
          ],
        },
      }),
    );

    const body = sentBody(recipients);
    expect(body.tools).toEqual([
      {
        name: "news_read",
        description: "Reads the association's news.",
        input_schema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    ]);
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.messages).toEqual([
      { role: "user", content: "Vad hände senast?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Jag läser nyheterna." },
          {
            type: "tool_use",
            id: "tu_1",
            name: "news_read",
            input: { id: "n1" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "{}",
            is_error: true,
          },
        ],
      },
    ]);
  });

  it("hands a turn the provider sent back exactly as it came, reasoning included", async () => {
    const { recipients, provider } = setup();
    recipients.answer(
      200,
      message({
        content: [
          { type: "thinking", thinking: "", signature: "sig-1" },
          { type: "tool_use", id: "tu_1", name: "news_read", input: {} },
        ],
        stop_reason: "tool_use",
      }),
    );
    const first = await provider.complete(call());
    recipients.answer(200, message());

    await provider.complete(
      call({
        request: {
          ...REQUEST,
          messages: [
            ...REQUEST.messages,
            first.message,
            {
              role: "user",
              content: [
                { type: "tool_result", toolUseId: "tu_1", content: "[]" },
              ],
            },
          ],
        },
      }),
    );

    expect((sentBody(recipients, 1).messages as unknown[])[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig-1" },
        { type: "tool_use", id: "tu_1", name: "news_read", input: {} },
      ],
    });
  });

  it("sends no sampling parameters, which the API version refuses", async () => {
    const { recipients, provider } = setup();
    recipients.answer(200, message());

    await provider.complete(call());

    const body = sentBody(recipients);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
  });

  it("waits no longer than the host allows", async () => {
    const { recipients, provider } = setup();
    recipients.answer(200, message());

    await provider.complete(
      call({ request: { ...REQUEST, timeoutMs: 900_000 } }),
    );

    expect(recipients.sent[0]?.init?.timeoutMs).toBe(300_000);
  });
});

describe("what comes back", () => {
  it("reads the text, the tool calls, the stop and the usage, and keeps the turn to hand back", async () => {
    const { recipients, provider } = setup();
    const content = [
      { type: "thinking", thinking: "", signature: "sig-1" },
      { type: "text", text: "Jag läser." },
      { type: "tool_use", id: "tu_1", name: "news_read", input: { id: "n1" } },
    ];
    recipients.answer(200, message({ content, stop_reason: "tool_use" }));

    const response = await provider.complete(call());

    expect(response).toEqual({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Jag läser." },
          {
            type: "tool_use",
            id: "tu_1",
            name: "news_read",
            input: { id: "n1" },
          },
        ],
        replay: content,
      },
      stop: "tool-use",
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      },
      model: "claude-opus-5-5",
    });
  });

  it.each([
    ["end_turn", "end"],
    ["stop_sequence", "end"],
    ["max_tokens", "max-tokens"],
    ["model_context_window_exceeded", "max-tokens"],
    ["tool_use", "tool-use"],
    ["refusal", "refusal"],
  ])("reads the stop reason %s as %s", async (stopReason, stop) => {
    const { recipients, provider } = setup();
    recipients.answer(200, message({ stop_reason: stopReason }));

    expect((await provider.complete(call())).stop).toBe(stop);
  });

  it("reports the model that answered, which a fallback may have changed", async () => {
    const { recipients, provider } = setup();
    recipients.answer(200, message({ model: "claude-opus-5" }));

    expect((await provider.complete(call())).model).toBe("claude-opus-5");
  });

  it("refuses an answer that stops for a reason no request here asks for, with its usage", async () => {
    const { recipients, provider } = setup();
    recipients.answer(200, message({ stop_reason: "pause_turn" }));

    const failed = await failure(provider.complete(call()));

    expect(failed.reason).toBe("bad-response");
    expect(failed.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    });
  });

  it.each([
    ["a body that is not JSON", "<html>Bad gateway</html>"],
    ["an answer without usage", { ...message(), usage: undefined }],
    [
      "an answer with a usage it cannot count",
      message({ usage: { input_tokens: -1, output_tokens: 3 } }),
    ],
    [
      "an answer with a cache read count it cannot count",
      message({
        usage: {
          input_tokens: 1,
          output_tokens: 3,
          cache_read_input_tokens: "7",
        },
      }),
    ],
    [
      "an answer with a cache write count it cannot count",
      message({
        usage: {
          input_tokens: 1,
          output_tokens: 3,
          cache_creation_input_tokens: -2,
        },
      }),
    ],
  ])("refuses %s", async (_name, body) => {
    const { recipients, provider } = setup();
    recipients.answer(200, body);

    expect((await failure(provider.complete(call()))).reason).toBe(
      "bad-response",
    );
  });
});

describe("a provider that gives no answer", () => {
  it.each([
    [401, "unauthorised"],
    [403, "unauthorised"],
    [400, "request-refused"],
    [402, "request-refused"],
    [404, "request-refused"],
    [413, "request-refused"],
    [500, "overloaded"],
    [529, "overloaded"],
  ] as const)("reads HTTP %i as %s", async (status, reason) => {
    const { recipients, provider } = setup();
    recipients.answer(status, {
      type: "error",
      error: { type: "some_error", message: "The provider's own words." },
    });

    const failed = await failure(provider.complete(call()));

    expect(failed.reason).toBe(reason);
    expect(failed.status).toBe(status);
    expect(failed.message).not.toContain("own words");
  });

  it("passes on how long a rate limit asks to wait", async () => {
    const { recipients, provider } = setup();
    recipients.answer(429, {}, { "retry-after": "17" });

    const failed = await failure(provider.complete(call()));

    expect(failed.reason).toBe("rate-limited");
    expect(failed.retryAfterSeconds).toBe(17);
  });

  it("ignores a wait it cannot read", async () => {
    const { recipients, provider } = setup();
    recipients.answer(
      529,
      {},
      { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
    );

    expect(
      (await failure(provider.complete(call()))).retryAfterSeconds,
    ).toBeNull();
  });

  it("reads a connection that failed as unreachable", async () => {
    const { recipients, provider } = setup();
    recipients.fail("unreachable");

    expect((await failure(provider.complete(call()))).reason).toBe(
      "unreachable",
    );
  });

  it("lets any other refusal by the host through as it is", async () => {
    const { recipients, provider } = setup();
    recipients.fail("address-refused");

    await expect(provider.complete(call())).rejects.toMatchObject({
      name: "PluginRecipientError",
      code: "address-refused",
    });
  });
});

describe("the own-key route", () => {
  it("is Anthropic, on the model the board chose, once a key is entered", () => {
    const recipients = new StandInRecipients() as PluginRecipients;

    expect(ownKeyRoute(aiSettings({ apiKey: "" }), recipients)).toBeNull();
    expect(
      ownKeyRoute(
        aiSettings({ apiKey: KEY, model: "claude-sonnet-5-5" }),
        recipients,
      ),
    ).toMatchObject({ name: "Anthropic", model: "claude-sonnet-5-5" });
  });

  it("sends the key without the blanks a paste left around it", async () => {
    const recipients = new StandInRecipients();
    recipients.answer(200, message());
    const provider = ownKeyRoute(
      aiSettings({ apiKey: `  ${KEY}\n` }),
      recipients as PluginRecipients,
    );

    await provider?.complete(call());

    expect(recipients.sent[0]?.init?.headers?.["x-api-key"]).toBe(KEY);
  });

  it.each([
    ["left out", {}],
    [
      "null",
      { cache_read_input_tokens: null, cache_creation_input_tokens: null },
    ],
  ])("reads cache counts that are %s as none", async (_name, cache) => {
    const { recipients, provider } = setup();
    recipients.answer(
      200,
      message({ usage: { input_tokens: 4, output_tokens: 3, ...cache } }),
    );

    const answer = await provider.complete(call());

    expect(answer.usage).toEqual({
      inputTokens: 4,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});
