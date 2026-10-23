import { describe, expect, it } from "vitest";

import {
  conversationOf,
  MAX_MESSAGE_LENGTH,
  MAX_MESSAGES,
  runSiteTurn,
  SITE_DISCLOSURE,
  type SiteTurnResponse,
} from "../src/assistant/site-assistant.ts";
import { canonicalJson } from "../src/assistant/tool-loop.ts";
import { TURN_KEPT_MS, TURN_STALE_MS, TURNS } from "../src/assistant/turns.ts";
import { AiGateway } from "../src/gateway.ts";
import type { ModelToolResult, ModelUserMessage } from "../src/provider.ts";
import {
  ActionRefusalStandIn,
  StandInActions,
  toolUse,
} from "./stand-in-actions.ts";
import {
  answer,
  FakeProvider,
  type StandIn,
  standIn,
  type StandInOptions,
} from "./stand-in-host.ts";

/**
 * The site and news assistant's turn, against a fake provider and a stand-in
 * for `host.actions`: what the model is offered, what happens to the calls it
 * chooses, and what a retried turn does.
 */

const TURN_ID = "7d1f3a52-3c4b-4d7e-9a1b-2c3d4e5f6a7b";
const OTHER_TURN = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const REQUEST = { id: "request-1" };

const BODY = [
  { type: "paragraph", runs: [{ text: "Städdagen är lördag 7 november." }] },
];

interface Setup extends StandIn {
  actions: StandInActions;
  provider: FakeProvider;
  clock: { now: Date };
  turn(turnId?: string, text?: string): Promise<SiteTurnResponse>;
}

function setup(options: StandInOptions = {}): Setup {
  const stand = standIn(options);
  const actions = new StandInActions();
  const host = { ...stand.host, actions: actions.asHost() };
  const provider = new FakeProvider();
  const clock = { now: new Date("2026-10-22T09:41:12Z") };
  const gateway = new AiGateway(host, {
    route: (settings) => (settings.apiKey === null ? null : provider),
    now: () => clock.now,
  });
  return {
    ...stand,
    host,
    actions,
    provider,
    clock,
    turn: (turnId = TURN_ID, text = "Skriv en nyhet om städdagen.") =>
      runSiteTurn(
        { ...host, actions: actions.asHost() },
        gateway,
        REQUEST,
        { turnId, messages: [{ role: "user", text }] },
        () => clock.now,
      ),
  };
}

/** The tool results the model was given in its latest call. */
function resultsGiven(provider: FakeProvider): ModelToolResult[] {
  const last = provider.calls.at(-1)?.request.messages.at(-1) as
    ModelUserMessage | undefined;
  return Array.isArray(last?.content)
    ? (last.content.filter(
        (block) => block.type === "tool_result",
      ) as ModelToolResult[])
    : [];
}

const NEWS = { slug: "staddag", title: "Städdag", blocks: BODY };

describe("a write the model chooses", () => {
  it("is proposed and never invoked, and leaves only a pending change", async () => {
    const { actions, provider, turn } = setup();
    provider.answers.push(
      toolUse({ name: "news_create", input: NEWS }),
      answer({}, "Nyheten väntar på din bekräftelse."),
    );

    const response = await turn();

    expect(actions.written).toEqual([]);
    expect(actions.held.map(({ name, input }) => ({ name, input }))).toEqual([
      { name: "news_create", input: NEWS },
    ]);
    expect(response).toEqual({
      outcome: "answered",
      answer: "Nyheten väntar på din bekräftelse.",
      proposals: [
        {
          id: "change-1",
          action: "news_create",
          title: "Title of news_create",
          path: "/app/pending-changes/change-1",
          expiresAt: "2026-10-29T09:41:12.000Z",
        },
      ],
    });
    // The model is told the change is held, not that it was made.
    expect(JSON.parse(resultsGiven(provider)[0]?.content ?? "{}")).toEqual({
      heldForConfirmation: true,
      pendingChange: "change-1",
      expiresAt: "2026-10-29T09:41:12.000Z",
    });
  });

  it("runs a read through invoke and hands the model its answer", async () => {
    const { actions, provider, turn } = setup();
    actions.answers.set("news_get", {
      id: "n1",
      title: "Städdag",
      revision: 4,
    });
    provider.answers.push(
      toolUse({ name: "news_get", input: { id: "n1" } }),
      answer(),
    );

    await turn();

    expect(actions.reads).toEqual([{ name: "news_get", input: { id: "n1" } }]);
    expect(actions.held).toEqual([]);
    expect(resultsGiven(provider)[0]).toMatchObject({
      content: JSON.stringify({ id: "n1", title: "Städdag", revision: 4 }),
    });
  });

  it("is proposed once when the model asks for the same change twice in a turn", async () => {
    const { actions, provider, turn } = setup();
    provider.answers.push(
      toolUse({ name: "news_create", input: NEWS, id: "a" }),
      // The same input with its keys in another order is the same change.
      toolUse({
        name: "news_create",
        input: { blocks: BODY, title: "Städdag", slug: "staddag" },
        id: "b",
      }),
      answer(),
    );

    const response = await turn();

    expect(actions.held).toHaveLength(1);
    expect(response).toMatchObject({ proposals: [{ id: "change-1" }] });
    expect(
      JSON.parse(resultsGiven(provider)[0]?.content ?? "{}"),
    ).toMatchObject({ pendingChange: "change-1" });
  });

  it("offers only the news and page actions the host lists, under their own names", async () => {
    const { actions, provider, turn } = setup();
    provider.answers.push(answer());

    await turn();

    expect(actions.listed).toEqual([
      { request: REQUEST, filter: { surface: "ai" } },
    ]);
    const tools = provider.calls[0]?.request.tools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual([
      "news_list",
      "news_get",
      "news_create",
      "news_update",
      "news_publish",
      "news_request_mailing",
      "page_get",
      "page_update",
    ]);
    // The dialect marker is left out of what the provider is sent.
    expect(tools[0]?.inputSchema).not.toHaveProperty("$schema");
    expect(provider.calls[0]?.disclosure).toEqual(SITE_DISCLOSURE);
  });

  it("answers a tool the host did not offer with a refusal, and calls nothing", async () => {
    const { actions, provider, turn } = setup();
    provider.answers.push(
      toolUse({ name: "news_delete", input: { id: "n1" } }),
      toolUse({ name: "document_list", input: {} }),
      answer(),
    );

    await turn();

    expect(actions.held).toEqual([]);
    expect(actions.reads).toEqual([]);
    expect(actions.written).toEqual([]);
    expect(resultsGiven(provider)[0]).toMatchObject({ isError: true });
  });

  it("hands the model the host's refusal of a proposal, with the fields it refused", async () => {
    const { actions, provider, turn } = setup();
    actions.refusals.set(
      "news_create",
      new ActionRefusalStandIn("invalid-body", "after-edit", {
        slug: ["Invalid string"],
      }),
    );
    provider.answers.push(
      toolUse({ name: "news_create", input: NEWS }),
      answer(),
    );

    const response = await turn();

    expect(response).toMatchObject({ outcome: "answered", proposals: [] });
    const result = resultsGiven(provider)[0];
    expect(result?.isError).toBe(true);
    expect(JSON.parse(result?.content ?? "{}")).toEqual({
      refused: "invalid-body",
      retry: "after-edit",
      details: { slug: ["Invalid string"] },
    });
  });

  it("proposes no news update without the revision it was read at", async () => {
    const { actions, provider, turn } = setup();
    provider.answers.push(
      toolUse({ name: "news_update", input: { id: "n1", ...NEWS } }),
      toolUse({
        name: "news_update",
        input: { id: "n1", ...NEWS, expectedRevision: 4 },
      }),
      answer(),
    );

    const response = await turn();

    expect(actions.held.map((held) => held.input)).toEqual([
      { id: "n1", ...NEWS, expectedRevision: 4 },
    ]);
    expect(response).toMatchObject({ proposals: [{ action: "news_update" }] });
    const first = provider.calls[1]?.request.messages.at(
      -1,
    ) as ModelUserMessage;
    expect(first.content).toEqual([
      expect.objectContaining({
        isError: true,
        content: JSON.stringify({
          refused: "expected-revision-required",
          retry: "after-edit",
        }),
      }),
    ]);
  });

  it("stops after a fixed number of calls to the model, keeping what it proposed", async () => {
    const { actions, provider, turn } = setup({
      settings: { requestsPerMinute: 120 },
    });
    provider.answers.push(toolUse({ name: "news_create", input: NEWS }));
    for (let round = 0; round < 20; round++) {
      provider.answers.push(toolUse({ name: "news_get", input: { id: "n1" } }));
    }

    const response = await turn();

    expect(response).toMatchObject({
      outcome: "too-many-rounds",
      proposals: [{ id: "change-1" }],
    });
    expect(provider.calls).toHaveLength(12);
    expect(actions.held).toHaveLength(1);
  });

  it("keeps the turn's proposals when the gateway stops it part-way", async () => {
    const { provider, turn } = setup({
      settings: { requestsPerMinute: 1 },
    });
    provider.answers.push(toolUse({ name: "news_create", input: NEWS }));

    const response = await turn();

    expect(response).toMatchObject({
      outcome: "refused",
      reason: "rate-limited",
      proposals: [{ id: "change-1" }],
    });
  });

  it("is not proposed on a host that cannot hold a change, and nothing is called", async () => {
    const { actions, provider, turn } = setup();
    actions.withPropose = false;

    expect(await turn()).toEqual({ outcome: "host-unsupported" });
    expect(provider.calls).toEqual([]);
    expect(actions.written).toEqual([]);
  });
});

describe("a mailing", () => {
  it("is only ever a request of its own, proposed apart from the publication", async () => {
    const { actions, provider, turn } = setup();
    provider.answers.push(
      toolUse(
        { name: "news_publish", input: { id: "n1" } },
        { name: "news_request_mailing", input: { id: "n1" } },
      ),
      answer(),
    );

    const response = await turn(TURN_ID, "Publicera och skicka ut nyheten.");

    // Two changes, each confirmed on its own: publishing sends nothing, and
    // the request is all the assistant can say about a mailing.
    expect(actions.held.map((held) => held.name)).toEqual([
      "news_publish",
      "news_request_mailing",
    ]);
    expect(response).toMatchObject({
      proposals: [{ id: "change-1" }, { id: "change-2" }],
    });
    expect(provider.calls[0]?.request.system).toContain("news_request_mailing");
    expect(provider.calls[0]?.request.system).toMatch(/cannot send anything/);
  });
});

describe("a retried turn", () => {
  it("proposes nothing again, and is told what the first proposed", async () => {
    const { actions, provider, turn } = setup();
    provider.answers.push(
      toolUse({ name: "news_create", input: NEWS }),
      answer(),
    );
    const first = await turn();

    provider.answers.push(
      toolUse({ name: "news_create", input: NEWS }),
      answer(),
    );
    const again = await turn();

    expect(actions.held).toHaveLength(1);
    expect(provider.calls).toHaveLength(2);
    expect(again).toEqual({
      outcome: "repeated",
      proposals: "proposals" in first ? first.proposals : [],
    });
  });

  it("is told the first is still running while it runs", async () => {
    const { provider, turn } = setup();
    let release = (): void => undefined;
    provider.gate = new Promise((resolve) => {
      release = resolve;
    });
    const first = turn();
    // Let the first claim the turn and reach the model.
    while (provider.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(await turn()).toEqual({ outcome: "in-progress" });
    release();
    expect(await first).toMatchObject({ outcome: "answered" });
  });

  it("does not run a turn whose request died, and gives what it had proposed", async () => {
    const { records, provider, turn, clock } = setup();
    await records.put(TURNS, TURN_ID, {
      startedAt: new Date(clock.now.getTime() - TURN_STALE_MS).toISOString(),
      finished: false,
      proposals: [
        {
          id: "change-9",
          action: "page_update",
          title: "Uppdatera en sida",
          path: "/app/pending-changes/change-9",
          expiresAt: "2026-10-29T09:00:00.000Z",
        },
      ],
    });

    expect(await turn()).toMatchObject({
      outcome: "repeated",
      proposals: [{ id: "change-9" }],
    });
    expect(provider.calls).toEqual([]);
  });

  it("is a turn of its own under another id", async () => {
    const { actions, provider, turn } = setup();
    provider.answers.push(
      toolUse({ name: "news_create", input: NEWS }),
      answer(),
    );
    await turn(TURN_ID);
    provider.answers.push(
      toolUse({ name: "news_create", input: NEWS }),
      answer(),
    );
    await turn(OTHER_TURN, "Skriv den igen.");

    expect(actions.held).toHaveLength(2);
  });
});

describe("what the package keeps of a turn", () => {
  it("is the receipts and nothing anybody wrote, and it is gone after an hour", async () => {
    const { records, provider, turn, clock } = setup();
    provider.answers.push(
      toolUse({ name: "news_create", input: NEWS }),
      answer({}, "Nyheten om städdagen väntar."),
    );
    await turn(TURN_ID, "Skriv en nyhet om städdagen lördag 7 november.");

    const kept = JSON.stringify(records.value(TURNS, TURN_ID));
    expect(kept).toContain("change-1");
    for (const written of ["Städdag", "staddag", "lördag", "väntar"]) {
      expect(kept).not.toContain(written);
    }

    clock.now = new Date(clock.now.getTime() + TURN_KEPT_MS + 1);
    provider.answers.push(answer());
    // A sweep starts at a random key; keep going until it reaches this one.
    for (
      let tries = 0;
      tries < 20 && records.keys(TURNS).includes(TURN_ID);
      tries++
    ) {
      await turn(crypto.randomUUID());
      provider.answers.push(answer());
    }
    expect(records.keys(TURNS)).not.toContain(TURN_ID);
  });
});

describe("the conversation the view sends", () => {
  it("is read when it alternates from the person and ends with them", () => {
    expect(
      conversationOf([
        { role: "user", text: "Skriv en nyhet." },
        { role: "assistant", text: "Om vad?" },
        { role: "user", text: "Städdagen." },
      ]),
    ).toHaveLength(3);
  });

  it.each([
    ["nothing", []],
    ["not a list", { role: "user", text: "Hej" }],
    [
      "ending with the assistant",
      [
        { role: "user", text: "Hej" },
        { role: "assistant", text: "Hej" },
      ],
    ],
    ["starting with the assistant", [{ role: "assistant", text: "Hej" }]],
    ["blank", [{ role: "user", text: "   " }]],
    ["too long", [{ role: "user", text: "x".repeat(MAX_MESSAGE_LENGTH + 1) }]],
    ["an extra key", [{ role: "user", text: "Hej", content: [] }]],
    [
      "too many",
      Array.from({ length: MAX_MESSAGES + 1 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        text: "Hej",
      })),
    ],
  ])("is refused when %s", (_case, value) => {
    expect(conversationOf(value)).toBeNull();
  });
});

describe("canonicalJson", () => {
  it("reads one input one way, whatever order its keys came in", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: [2, { e: 0, f: 1 }] }, b: 1 }),
    );
  });
});
