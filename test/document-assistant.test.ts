import { describe, expect, it } from "vitest";

import {
  ANSWER_TOOL,
  AssistantRefusal,
  DocumentAssistant,
  LAST_CALL,
  MAX_CHARACTERS_READ,
  MAX_MODEL_CALLS,
  MAX_TOOL_CALLS_PER_TURN,
  NO_ANSWER_TOOL,
  QUESTION_TOKEN_BUDGET,
  SYSTEM_PROMPT,
} from "../src/document-assistant.ts";
import { AiGateway, AiRefusal } from "../src/gateway.ts";
import {
  type ModelAssistantMessage,
  type ModelResponse,
  type ModelToolResult,
  type ModelUserMessage,
  totalTokens,
} from "../src/provider.ts";
import {
  ActionRefusalStandIn,
  BYLAWS,
  MINUTES,
  SCANNED,
  StandInArchive,
  type StandInDocument,
} from "./stand-in-archive.ts";
import {
  FakeProvider,
  type StandIn,
  standIn,
  type StandInOptions,
} from "./stand-in-host.ts";

/**
 * The document assistant against a fake provider and a stand-in for the
 * core's document reads: what the model is offered, how its reads are
 * dispatched, and that no answer leaves without a source the conversation
 * read.
 */

const QUESTION = "Hur många ledamöter får styrelsen ha?";

/** The request the route is serving, which only the host can tell apart. */
const REQUEST = Object.freeze({ id: "the-route's-request" });

interface Setup extends StandIn {
  archive: StandInArchive;
  provider: FakeProvider;
  assistant: DocumentAssistant;
}

function setup(
  options: StandInOptions & { documents?: StandInDocument[] } = {},
): Setup {
  const archive = new StandInArchive(options.documents);
  const stand = standIn({ actions: archive, ...options });
  const provider = new FakeProvider();
  const gateway = new AiGateway(stand.host, {
    route: (settings) => (settings.apiKey === null ? null : provider),
    now: () => new Date("2026-10-22T09:41:12Z"),
  });
  return {
    ...stand,
    archive,
    provider,
    assistant: new DocumentAssistant(stand.host, gateway),
  };
}

let ids = 0;

function use(name: string, input: unknown) {
  ids += 1;
  return {
    type: "tool_use" as const,
    id: `tu_${String(ids)}`,
    name,
    input,
  };
}

/** One turn of the model's, stopping for its tools when it calls any. */
function turn(...content: ModelAssistantMessage["content"]): ModelResponse {
  return {
    message: { role: "assistant", content },
    stop: content.some((block) => block.type === "tool_use")
      ? "tool-use"
      : "end",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    model: "fake-model",
  };
}

/** A turn that used `tokens` in all, as the monthly limit counts them. */
function costing(response: ModelResponse, tokens: number): ModelResponse {
  return {
    ...response,
    usage: {
      ...response.usage,
      inputTokens: tokens - response.usage.outputTokens,
    },
  };
}

/** What the calls the provider answered used, as the limit counts it. */
function used(provider: FakeProvider, answered: readonly ModelResponse[]) {
  return answered
    .slice(0, provider.calls.length)
    .reduce((total, response) => total + totalTokens(response.usage), 0);
}

type ToolUse = ReturnType<typeof use>;

const read = (id: string, fromPage = 1) =>
  use("document_get", { id, fromPage });

const give = (sources: unknown, answer = "Lägst tre och högst sju (§ 14).") =>
  use(ANSWER_TOOL, { answer, sources });

/** The tool results the call at `index` sent, in order. */
function resultsSent(provider: FakeProvider, index: number): ModelToolResult[] {
  const messages = provider.calls[index]?.request.messages ?? [];
  const last = messages.at(-1) as ModelUserMessage | undefined;
  return Array.isArray(last?.content)
    ? (last.content.filter(
        (block) => block.type === "tool_result",
      ) as ModelToolResult[])
    : [];
}

async function refusal<Refusal extends Error>(
  promise: Promise<unknown>,
  type: abstract new (...args: never[]) => Refusal,
): Promise<Refusal> {
  const error = await promise.then(
    () => {
      throw new Error("The question was answered.");
    },
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(type);
  return error as Refusal;
}

describe("an answer from the documents", () => {
  it("answers with the documents and pages it rests on, as the archive names them", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      turn(use("document_list", { search: "stadgar" })),
      turn(read(BYLAWS.id)),
      turn(
        give(
          [{ documentId: BYLAWS.id, pages: [2] }],
          "Styrelsen består av lägst tre och högst sju ledamöter (§ 14).",
        ),
      ),
    );

    const answer = await assistant.ask(REQUEST, QUESTION);

    expect(answer).toEqual({
      outcome: "answered",
      answer: "Styrelsen består av lägst tre och högst sju ledamöter (§ 14).",
      sources: [
        {
          id: BYLAWS.id,
          title: "Stadgar 2024",
          category: "Stadgar",
          audience: "MEMBER",
          pages: [2],
        },
      ],
    });
    expect(provider.calls).toHaveLength(3);
  });

  it("dispatches every read as the person whose request the route serves", async () => {
    const { assistant, provider, archive } = setup();
    provider.answers.push(
      turn(use("document_list", {})),
      turn(read(BYLAWS.id)),
      turn(give([{ documentId: BYLAWS.id, pages: [2] }])),
    );

    await assistant.ask(REQUEST, QUESTION);

    expect(archive.listed.map((each) => each.request)).toEqual([REQUEST]);
    expect(archive.listed[0]?.input).toEqual({
      surface: "ai",
      group: "documents",
    });
    expect(archive.dispatched.map((each) => [each.name, each.request])).toEqual(
      [
        ["document_list", REQUEST],
        ["document_get", REQUEST],
      ],
    );
  });

  it("offers the model the two document reads and its own two tools, and nothing else", async () => {
    const { assistant, provider, archive } = setup();
    archive.offered.push({
      name: "document_delete",
      title: "Delete a document",
      description: "Deletes a document.",
      group: "documents",
      effect: "delete",
      personalData: [],
      inputSchema: { type: "object" },
    });
    provider.answers.push(turn(use(NO_ANSWER_TOOL, { explanation: "Inget." })));

    await assistant.ask(REQUEST, QUESTION);

    const request = provider.calls[0]?.request;
    expect(request?.tools?.map((tool) => tool.name)).toEqual([
      "document_list",
      "document_get",
      ANSWER_TOOL,
      NO_ANSWER_TOOL,
    ]);
    // The core's descriptions and schemas, as the host listed them.
    expect(request?.tools?.[1]).toEqual({
      name: "document_get",
      description: "Reads the text of up to ten pages of one document.",
      inputSchema: expect.objectContaining({ required: ["id"] }),
    });
    expect(request?.tools?.slice(2).every((tool) => tool.strict)).toBe(true);
    expect(request).toMatchObject({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: QUESTION }],
      effort: "medium",
      cache: true,
    });
  });

  it("hands the model each read's output whole, and its refusals by reason", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      turn(read("doc-gone"), read(MINUTES.id)),
      turn(give([{ documentId: MINUTES.id, pages: [1] }], "Med 3 procent.")),
    );

    await assistant.ask(REQUEST, "Hur mycket höjs avgiften?");

    const [missing, minutes] = resultsSent(provider, 1);
    expect(missing).toMatchObject({ isError: true });
    expect(JSON.parse(missing?.content ?? "")).toEqual({
      refused: "not-found",
      retry: "after-edit",
    });
    expect(minutes?.isError).toBeUndefined();
    expect(JSON.parse(minutes?.content ?? "")).toMatchObject({
      id: MINUTES.id,
      pages: [{ number: 1, text: MINUTES.pages[0] }],
    });
  });

  it("passes on which fields an input got wrong, so the model can correct it", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      turn(use("document_get", {})),
      turn(use(NO_ANSWER_TOOL, { explanation: "Inget." })),
    );

    await assistant.ask(REQUEST, QUESTION);

    expect(JSON.parse(resultsSent(provider, 1)[0]?.content ?? "")).toEqual({
      refused: "invalid-body",
      retry: "after-edit",
      issues: [{ path: ["id"], message: "Required" }],
    });
  });

  it("lets a failure that is not a refusal through, as a fault", async () => {
    const { assistant, provider, archive } = setup();
    archive.failWith = new Error("database gone");
    provider.answers.push(turn(read(BYLAWS.id)));

    await expect(assistant.ask(REQUEST, QUESTION)).rejects.toThrow(
      "database gone",
    );
  });

  it("names the personal data each call carries: the question's free text, then what the reads declare", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      turn(read(BYLAWS.id)),
      turn(give([{ documentId: BYLAWS.id, pages: [2] }])),
    );

    await assistant.ask(REQUEST, QUESTION);

    expect(provider.calls.map((call) => call.disclosure)).toEqual([
      { personalData: ["freeText"], subjects: [] },
      { personalData: ["freeText", "name"], subjects: [] },
    ]);
  });

  it("merges two sources from one document and orders their pages", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      turn(read(BYLAWS.id)),
      turn(
        give([
          { documentId: BYLAWS.id, pages: [3, 2] },
          { documentId: BYLAWS.id, pages: [2, 1] },
        ]),
      ),
    );

    const answer = await assistant.ask(REQUEST, QUESTION);

    expect(answer.outcome === "answered" && answer.sources).toEqual([
      expect.objectContaining({ id: BYLAWS.id, pages: [1, 2, 3] }),
    ]);
  });

  it("accepts an answer from an earlier turn's read, and dispatches none of the same turn's reads", async () => {
    const { assistant, provider, archive } = setup();
    provider.answers.push(
      turn(read(BYLAWS.id)),
      turn(read(MINUTES.id), give([{ documentId: BYLAWS.id, pages: [2] }])),
    );

    const answer = await assistant.ask(REQUEST, QUESTION);

    expect(answer.outcome).toBe("answered");
    expect(provider.calls).toHaveLength(2);
    expect(archive.dispatched.map((each) => each.input)).toEqual([
      { id: BYLAWS.id, fromPage: 1 },
    ]);
  });
});

describe("a source read in the same turn as the answer", () => {
  it.each([
    ["after the read", (answer: ToolUse, get: ToolUse) => [get, answer]],
    ["before the read", (answer: ToolUse, get: ToolUse) => [answer, get]],
  ])(
    "is refused when the answer comes %s, since the model has not seen it",
    async (_order, arrange) => {
      const { assistant, provider } = setup();
      const get = read(BYLAWS.id);
      const answer = give([{ documentId: BYLAWS.id, pages: [2] }]);
      provider.answers.push(
        turn(...arrange(answer, get)),
        turn(give([{ documentId: BYLAWS.id, pages: [2] }])),
      );

      const result = await assistant.ask(REQUEST, QUESTION);

      // The first call carried the question alone; the answer stands only
      // once the read's text has reached the model in the second.
      expect(provider.calls[0]?.request.messages).toEqual([
        { role: "user", content: QUESTION },
      ]);
      expect(provider.calls).toHaveLength(2);
      expect(result.outcome).toBe("answered");
      const results = resultsSent(provider, 1);
      expect(results.map((each) => each.toolUseId)).toEqual(
        arrange(answer, get).map((each) => each.id),
      );
      const refused = results.find((each) => each.toolUseId === answer.id);
      expect(refused).toMatchObject({ isError: true });
      expect(refused?.content).toContain(
        '"doc-bylaws" is not a document this conversation read with document_get.',
      );
      const delivered = results.find((each) => each.toolUseId === get.id);
      expect(JSON.parse(delivered?.content ?? "")).toMatchObject({
        id: BYLAWS.id,
        pages: expect.arrayContaining([{ number: 2, text: BYLAWS.pages[1] }]),
      });
    },
  );

  it("does not let a page read earlier stand in for one read in the same turn", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      turn(use("document_get", { id: BYLAWS.id, fromPage: 1, toPage: 1 })),
      turn(
        use("document_get", { id: BYLAWS.id, fromPage: 2, toPage: 2 }),
        give([{ documentId: BYLAWS.id, pages: [1, 2] }]),
      ),
      turn(give([{ documentId: BYLAWS.id, pages: [1, 2] }])),
    );

    const answer = await assistant.ask(REQUEST, QUESTION);

    expect(resultsSent(provider, 2)[1]?.content).toContain(
      "doc-bylaws: page 2 was not read with document_get, or had no text.",
    );
    expect(answer.outcome === "answered" && answer.sources).toEqual([
      expect.objectContaining({ id: BYLAWS.id, pages: [1, 2] }),
    ]);
  });
});

describe("a source the conversation did not read", () => {
  it("is refused back to the model, which may correct it", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      turn(use("document_list", {})),
      // The list names the bylaws, but nothing has read them.
      turn(give([{ documentId: BYLAWS.id, pages: [2] }])),
      turn(read(BYLAWS.id)),
      turn(give([{ documentId: BYLAWS.id, pages: [2] }])),
    );

    const answer = await assistant.ask(REQUEST, QUESTION);

    expect(answer.outcome).toBe("answered");
    const [refused] = resultsSent(provider, 2);
    expect(refused).toMatchObject({ isError: true });
    expect(refused?.content).toContain(
      '"doc-bylaws" is not a document this conversation read with document_get.',
    );
  });

  it("refuses a page that was not read, or that had no text", async () => {
    const { assistant, provider } = setup({ documents: [BYLAWS, SCANNED] });
    provider.answers.push(
      turn(use("document_get", { id: BYLAWS.id, fromPage: 1, toPage: 1 })),
      turn(read(SCANNED.id)),
      turn(
        give([
          { documentId: BYLAWS.id, pages: [2] },
          { documentId: SCANNED.id, pages: [1] },
        ]),
      ),
      turn(use(NO_ANSWER_TOOL, { explanation: "Planen är inskannad." })),
    );

    const answer = await assistant.ask(REQUEST, QUESTION);

    expect(answer.outcome).toBe("not-in-documents");
    const content = resultsSent(provider, 3)[0]?.content ?? "";
    expect(content).toContain(
      "doc-bylaws: page 2 was not read with document_get, or had no text.",
    );
    expect(content).toContain(
      "doc-scanned: page 1 was not read with document_get, or had no text.",
    );
  });

  it("refuses an answer without sources, and points to the other tool", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      turn(give([])),
      turn(use(NO_ANSWER_TOOL, { explanation: "Inget." })),
    );

    await assistant.ask(REQUEST, QUESTION);

    expect(resultsSent(provider, 1)[0]?.content).toContain(NO_ANSWER_TOOL);
  });

  it("refuses an answer that is empty or names pages a model made up", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      turn(read(BYLAWS.id)),
      turn(give([{ documentId: BYLAWS.id, pages: [2] }], "   ")),
      turn(give([{ documentId: BYLAWS.id, pages: ["2", 2.5] }])),
      turn(give([{ documentId: BYLAWS.id }])),
      turn(give([{ documentId: BYLAWS.id, pages: [2] }])),
    );

    const answer = await assistant.ask(REQUEST, QUESTION);

    expect(answer.outcome).toBe("answered");
    expect(resultsSent(provider, 2)[0]?.content).toBe("The answer is empty.");
    expect(resultsSent(provider, 3)[0]?.content).toContain(
      'page "2" was not read',
    );
    expect(resultsSent(provider, 4)[0]?.content).toContain(
      "doc-bylaws: name the pages.",
    );
  });

  it("never reaches the board member: a model that keeps naming one runs out of calls", async () => {
    const { assistant, provider } = setup();
    for (let call = 0; call < MAX_MODEL_CALLS; call++) {
      provider.answers.push(
        turn(give([{ documentId: BYLAWS.id, pages: [2] }])),
      );
    }

    const refused = await refusal(
      assistant.ask(REQUEST, QUESTION),
      AssistantRefusal,
    );

    expect(refused.reason).toBe("no-answer");
    expect(provider.calls).toHaveLength(MAX_MODEL_CALLS);
  });
});

describe("no answer in the documents", () => {
  it("says so, with the documents it read", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      turn(read(MINUTES.id)),
      turn(
        use(NO_ANSWER_TOOL, {
          explanation: "Protokollet tar inte upp styrelsens storlek.",
        }),
      ),
    );

    const answer = await assistant.ask(REQUEST, QUESTION);

    expect(answer).toEqual({
      outcome: "not-in-documents",
      explanation: "Protokollet tar inte upp styrelsens storlek.",
      consulted: [
        {
          id: MINUTES.id,
          title: MINUTES.title,
          category: "Protokoll",
          audience: "MEMBER",
        },
      ],
    });
  });

  it("refuses an empty explanation", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      turn(use(NO_ANSWER_TOOL, { explanation: "" })),
      turn(use(NO_ANSWER_TOOL, { explanation: "Inget om det." })),
    );

    const answer = await assistant.ask(REQUEST, QUESTION);

    expect(answer.outcome).toBe("not-in-documents");
    expect(resultsSent(provider, 1)[0]).toMatchObject({ isError: true });
  });
});

describe("a model that does not finish", () => {
  it("is reminded once to finish with a tool, and then has no answer", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      turn({ type: "text", text: "Sju ledamöter." }),
      turn({ type: "text", text: "Sju ledamöter, sa jag." }),
    );

    const refused = await refusal(
      assistant.ask(REQUEST, QUESTION),
      AssistantRefusal,
    );

    expect(refused.reason).toBe("no-answer");
    const reminder = provider.calls[1]?.request.messages.at(-1);
    expect(reminder).toMatchObject({ role: "user" });
    expect(reminder?.content).toContain(ANSWER_TOOL);
  });

  it("answers after the reminder", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      turn({ type: "text", text: "Sju ledamöter." }),
      turn(read(BYLAWS.id)),
      turn(give([{ documentId: BYLAWS.id, pages: [2] }])),
    );

    expect((await assistant.ask(REQUEST, QUESTION)).outcome).toBe("answered");
  });

  it("has no answer when the model declines", async () => {
    const { assistant, provider } = setup();
    provider.answers.push({ ...turn(), stop: "refusal" });

    const refused = await refusal(
      assistant.ask(REQUEST, QUESTION),
      AssistantRefusal,
    );

    expect(refused.reason).toBe("model-declined");
  });

  it("has no answer when the model runs out of room", async () => {
    const { assistant, provider } = setup();
    provider.answers.push({
      ...turn(give([{ documentId: BYLAWS.id, pages: [2] }])),
      stop: "max-tokens",
    });

    const refused = await refusal(
      assistant.ask(REQUEST, QUESTION),
      AssistantRefusal,
    );

    expect(refused.reason).toBe("no-answer");
  });

  it("stops after the calls one question may make, however it goes on reading", async () => {
    const { assistant, provider, archive } = setup();
    for (let call = 0; call < MAX_MODEL_CALLS + 2; call++) {
      provider.answers.push(turn(use("document_list", {})));
    }

    const refused = await refusal(
      assistant.ask(REQUEST, QUESTION),
      AssistantRefusal,
    );

    expect(refused.reason).toBe("no-answer");
    expect(provider.calls).toHaveLength(MAX_MODEL_CALLS);
    // The last call says it is, and the reads asked for in it are not made.
    expect(
      provider.calls.at(-1)?.request.messages.at(-1)?.content,
    ).toContainEqual({ type: "text", text: LAST_CALL });
    expect(
      provider.calls
        .slice(0, -1)
        .map((call) => JSON.stringify(call.request.messages)),
    ).not.toContainEqual(expect.stringContaining(LAST_CALL));
    expect(archive.dispatched).toHaveLength(MAX_MODEL_CALLS - 1);
  });
});

describe("the question's token budget", () => {
  it("stops at the budget, after a last call the model is told to finish in", async () => {
    const { assistant, provider, archive } = setup();
    // Two calls as large as the first would pass the budget after it.
    const answered = Array.from({ length: MAX_MODEL_CALLS }, () =>
      costing(turn(use("document_list", {})), QUESTION_TOKEN_BUDGET * 0.4),
    );
    provider.answers.push(...answered);

    const refused = await refusal(
      assistant.ask(REQUEST, QUESTION),
      AssistantRefusal,
    );

    expect(refused.reason).toBe("no-answer");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.request.messages.at(-1)?.content).toContainEqual({
      type: "text",
      text: LAST_CALL,
    });
    expect(archive.dispatched).toHaveLength(1);
    expect(used(provider, answered)).toBeLessThanOrEqual(QUESTION_TOKEN_BUDGET);
  });

  it("goes on while another call as large fits, and never passes the budget when the calls do not grow", async () => {
    const { assistant, provider } = setup();
    const answered = Array.from({ length: MAX_MODEL_CALLS }, () =>
      costing(turn(use("document_list", {})), QUESTION_TOKEN_BUDGET * 0.2),
    );
    provider.answers.push(...answered);

    await refusal(assistant.ask(REQUEST, QUESTION), AssistantRefusal);

    // After four calls a fifth as large still fits, and a sixth would not.
    expect(provider.calls).toHaveLength(5);
    expect(used(provider, answered)).toBe(QUESTION_TOKEN_BUDGET);
  });

  it("answers in the last call", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      costing(turn(read(BYLAWS.id)), QUESTION_TOKEN_BUDGET * 0.4),
      turn(give([{ documentId: BYLAWS.id, pages: [2] }])),
    );

    const answer = await assistant.ask(REQUEST, QUESTION);

    expect(answer.outcome).toBe("answered");
    // After the read's output, as the last thing the model is told.
    const content = provider.calls[1]?.request.messages.at(-1)?.content;
    expect(
      Array.isArray(content) && content.map((block) => block.type),
    ).toEqual(["tool_result", "text"]);
  });

  it("tells a model reminded to finish in its last call both", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      costing(
        turn({ type: "text", text: "Sju ledamöter." }),
        QUESTION_TOKEN_BUDGET * 0.4,
      ),
      turn(use(NO_ANSWER_TOOL, { explanation: "Inget." })),
    );

    await assistant.ask(REQUEST, QUESTION);

    const reminder = provider.calls[1]?.request.messages.at(-1)?.content;
    expect(reminder).toEqual(expect.stringContaining(ANSWER_TOOL));
    expect(reminder).toEqual(expect.stringContaining(LAST_CALL));
  });

  it("makes no call once a call has used up the budget", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      turn(use("document_list", {})),
      costing(turn(use("document_list", {})), QUESTION_TOKEN_BUDGET),
      turn(use(NO_ANSWER_TOOL, { explanation: "Inget." })),
    );

    const refused = await refusal(
      assistant.ask(REQUEST, QUESTION),
      AssistantRefusal,
    );

    expect(refused.reason).toBe("no-answer");
    expect(provider.calls).toHaveLength(2);
  });

  it("dispatches no read of the call that crosses the budget", async () => {
    const { assistant, provider, archive } = setup();
    provider.answers.push(
      costing(turn(use("document_list", {})), 40_000),
      costing(turn(use("document_list", {})), 40_000),
      costing(turn(use("document_list", {})), 40_000),
      costing(turn(read(BYLAWS.id)), 140_000),
    );

    const refused = await refusal(
      assistant.ask(REQUEST, QUESTION),
      AssistantRefusal,
    );

    expect(refused.reason).toBe("no-answer");
    expect(provider.calls).toHaveLength(4);
    expect(archive.dispatched).toHaveLength(3);
  });

  it("gives no outcome from the call that crosses the budget", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      costing(turn(use("document_list", {})), 40_000),
      costing(turn(use("document_list", {})), 40_000),
      costing(turn(use("document_list", {})), 40_000),
      costing(turn(use(NO_ANSWER_TOOL, { explanation: "Inget." })), 140_000),
    );

    const refused = await refusal(
      assistant.ask(REQUEST, QUESTION),
      AssistantRefusal,
    );

    expect(refused.reason).toBe("no-answer");
  });

  it("dispatches no read of a call that uses the budget up exactly", async () => {
    const { assistant, provider, archive } = setup();
    provider.answers.push(
      costing(turn(use("document_list", {})), 40_000),
      costing(turn(use("document_list", {})), 40_000),
      costing(turn(use("document_list", {})), 40_000),
      costing(turn(read(BYLAWS.id)), QUESTION_TOKEN_BUDGET - 120_000),
    );

    const refused = await refusal(
      assistant.ask(REQUEST, QUESTION),
      AssistantRefusal,
    );

    expect(refused.reason).toBe("no-answer");
    expect(provider.calls).toHaveLength(4);
    expect(archive.dispatched).toHaveLength(3);
  });

  it("accepts an answer from a call that ends exactly on the budget", async () => {
    const { assistant, provider } = setup();
    provider.answers.push(
      costing(turn(read(BYLAWS.id)), QUESTION_TOKEN_BUDGET * 0.4),
      costing(
        turn(give([{ documentId: BYLAWS.id, pages: [2] }])),
        QUESTION_TOKEN_BUDGET * 0.6,
      ),
    );

    const answer = await assistant.ask(REQUEST, QUESTION);

    expect(answer.outcome).toBe("answered");
  });

  it("refuses a question when less than its budget is left of the month, before anything is read", async () => {
    const { assistant, provider, archive } = setup({
      settings: { monthlyTokenLimit: QUESTION_TOKEN_BUDGET - 1 },
    });

    const refused = await refusal(
      assistant.ask(REQUEST, QUESTION),
      AssistantRefusal,
    );

    expect(refused.reason).toBe("too-little-left");
    expect(provider.calls).toEqual([]);
    expect(archive.dispatched).toEqual([]);
  });

  it("asks a question with its budget left of the month", async () => {
    const { assistant, provider } = setup({
      settings: { monthlyTokenLimit: QUESTION_TOKEN_BUDGET },
    });
    provider.answers.push(turn(use(NO_ANSWER_TOOL, { explanation: "Inget." })));

    expect((await assistant.ask(REQUEST, QUESTION)).outcome).toBe(
      "not-in-documents",
    );
  });

  it("leaves a month with nothing left to the gateway's refusal", async () => {
    const { assistant, provider } = setup({
      settings: { monthlyTokenLimit: 0 },
    });

    const refused = await refusal(assistant.ask(REQUEST, QUESTION), AiRefusal);

    expect(refused.reason).toBe("usage-limit-reached");
    expect(provider.calls).toEqual([]);
  });
});

describe("what one question may spend", () => {
  it("answers only so many tool calls of one turn, and dispatches none of the rest", async () => {
    const { assistant, provider, archive } = setup();
    provider.answers.push(
      turn(
        ...Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 2 }, () =>
          use("document_list", {}),
        ),
      ),
      turn(use(NO_ANSWER_TOOL, { explanation: "Inget." })),
    );

    await assistant.ask(REQUEST, QUESTION);

    expect(archive.dispatched).toHaveLength(MAX_TOOL_CALLS_PER_TURN);
    const results = resultsSent(provider, 1);
    expect(results).toHaveLength(MAX_TOOL_CALLS_PER_TURN + 2);
    expect(results.slice(MAX_TOOL_CALLS_PER_TURN)).toEqual([
      expect.objectContaining({ isError: true }),
      expect.objectContaining({ isError: true }),
    ]);
  });

  it("reads no more text once a question has read its share", async () => {
    const long: StandInDocument = {
      id: "doc-long",
      title: "Underhållsplan",
      category: "Underhåll",
      audience: "MEMBER",
      pages: Array.from({ length: 50 }, () => "x".repeat(20_000)),
    };
    const { assistant, provider, archive } = setup({ documents: [long] });
    const reads = Math.ceil(MAX_CHARACTERS_READ / 60_000);
    for (let call = 0; call < reads; call++) {
      provider.answers.push(turn(read(long.id, 1 + call * 3)));
    }
    provider.answers.push(
      turn(read(long.id, 40)),
      turn(use(NO_ANSWER_TOOL, { explanation: "För långt." })),
    );

    await assistant.ask(REQUEST, QUESTION);

    expect(archive.dispatched).toHaveLength(reads);
    expect(resultsSent(provider, reads + 1)[0]).toMatchObject({
      isError: true,
      content: expect.stringContaining("as much text as one question may"),
    });
  });

  it("cuts a read short where the question's share runs out, and lets only what was sent be cited", async () => {
    // Every page 10,000 characters but the fifteenth, one short: five reads
    // of three pages come to 149,999 characters, one below the share.
    const long: StandInDocument = {
      id: "doc-long",
      title: "Underhållsplan",
      category: "Underhåll",
      audience: "MEMBER",
      pages: Array.from({ length: 30 }, (_, index) =>
        "x".repeat(index === 14 ? 9_999 : 10_000),
      ),
    };
    const { assistant, provider } = setup({ documents: [long] });
    const pages = (fromPage: number) =>
      use("document_get", { id: long.id, fromPage, toPage: fromPage + 2 });
    for (const fromPage of [1, 4, 7, 10, 13, 16]) {
      provider.answers.push(turn(pages(fromPage)));
    }
    provider.answers.push(
      turn(give([{ documentId: long.id, pages: [17] }])),
      turn(give([{ documentId: long.id, pages: [16] }])),
    );

    const answer = await assistant.ask(REQUEST, QUESTION);

    const sent = Array.from({ length: 6 }, (_, call) =>
      JSON.parse(resultsSent(provider, call + 1)[0]?.content ?? "{}"),
    );
    const characters = sent
      .flatMap((output) => output.pages as { text: string }[])
      .reduce((total, page) => total + page.text.length, 0);
    expect(characters).toBe(MAX_CHARACTERS_READ);
    // The sixth read had room for one character: page 16 begins, and the
    // rest of it and pages 17 and 18 are not sent.
    expect(sent[5]).toMatchObject({
      pages: [{ number: 16, text: "x" }],
      truncated: true,
      next: { fromPage: 16, fromCharacter: 1 },
    });
    expect(resultsSent(provider, 7)[0]?.content).toContain(
      "doc-long: page 17 was not read with document_get, or had no text.",
    );
    expect(answer.outcome === "answered" && answer.sources).toEqual([
      expect.objectContaining({ id: long.id, pages: [16] }),
    ]);
  });

  it("places the cut from where a read that starts inside a page starts", async () => {
    const long: StandInDocument = {
      id: "doc-long",
      title: "Underhållsplan",
      category: "Underhåll",
      audience: "MEMBER",
      pages: Array.from({ length: 30 }, (_, index) =>
        "x".repeat(index === 14 ? 9_999 : 10_000),
      ),
    };
    const { assistant, provider } = setup({ documents: [long] });
    for (const fromPage of [1, 4, 7, 10, 13]) {
      provider.answers.push(
        turn(
          use("document_get", { id: long.id, fromPage, toPage: fromPage + 2 }),
        ),
      );
    }
    provider.answers.push(
      turn(
        use("document_get", {
          id: long.id,
          fromPage: 16,
          fromCharacter: 5_000,
          toPage: 17,
        }),
      ),
      turn(use(NO_ANSWER_TOOL, { explanation: "För långt." })),
    );

    await assistant.ask(REQUEST, QUESTION);

    expect(
      JSON.parse(resultsSent(provider, 6)[0]?.content ?? ""),
    ).toMatchObject({
      pages: [{ number: 16, text: "x" }],
      truncated: true,
      next: { fromPage: 16, fromCharacter: 5_001 },
    });
  });

  it("refuses a tool the model made up, and dispatches nothing for it", async () => {
    const { assistant, provider, archive } = setup();
    provider.answers.push(
      turn(use("document_delete", { id: BYLAWS.id })),
      turn(use(NO_ANSWER_TOOL, { explanation: "Inget." })),
    );

    await assistant.ask(REQUEST, QUESTION);

    expect(archive.dispatched).toEqual([]);
    expect(resultsSent(provider, 1)[0]).toMatchObject({
      isError: true,
      content: "There is no tool by that name.",
    });
  });
});

describe("before the model is called", () => {
  it("refuses when the host offers no document reads to this person", async () => {
    const { assistant, provider, archive } = setup();
    archive.offered = archive.offered.filter(
      (action) => action.name !== "document_get",
    );

    const refused = await refusal(
      assistant.ask(REQUEST, QUESTION),
      AssistantRefusal,
    );

    expect(refused.reason).toBe("documents-unavailable");
    expect(provider.calls).toEqual([]);
  });

  it("refuses on a host that lists the reads without their schemas", async () => {
    const { assistant, provider, archive } = setup();
    archive.offered = archive.offered.map(
      ({ inputSchema: _input, outputSchema: _output, ...summary }) => summary,
    );

    const refused = await refusal(
      assistant.ask(REQUEST, QUESTION),
      AssistantRefusal,
    );

    expect(refused.reason).toBe("documents-unavailable");
    expect(provider.calls).toEqual([]);
  });

  it("asks the gateway, so a missing licence makes no call", async () => {
    const { assistant, provider } = setup({
      entitlement: { status: "absent" },
    });

    const refused = await refusal(assistant.ask(REQUEST, QUESTION), AiRefusal);

    expect(refused.reason).toBe("entitlement-required");
    expect(provider.calls).toEqual([]);
  });
});

describe("what is kept", () => {
  it("keeps neither the question, nor what was read, nor the answer", async () => {
    const { assistant, provider, records, logged } = setup();
    provider.answers.push(
      turn(read(BYLAWS.id)),
      turn(give([{ documentId: BYLAWS.id, pages: [2] }])),
    );

    await assistant.ask(REQUEST, QUESTION);

    const stored = JSON.stringify([...records.rows.values()]);
    const said = JSON.stringify(logged);
    for (const text of [QUESTION, BYLAWS.pages[1] ?? "", "Lägst tre"]) {
      expect(stored).not.toContain(text);
      expect(said).not.toContain(text);
    }
  });
});

describe("a refusal by the registry", () => {
  it("reaches the model by its reason, as one by the archive does", async () => {
    const { assistant, provider, archive } = setup();
    archive.failWith = new ActionRefusalStandIn(
      "registry",
      "forbidden-surface",
      "never",
    );
    provider.answers.push(
      turn(read(BYLAWS.id)),
      turn(use(NO_ANSWER_TOOL, { explanation: "Kunde inte läsa." })),
    );

    await assistant.ask(REQUEST, QUESTION);

    expect(JSON.parse(resultsSent(provider, 1)[0]?.content ?? "")).toEqual({
      refused: "forbidden-surface",
      retry: "never",
    });
  });
});
