import "reflect-metadata";

import { createRequire } from "node:module";

import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import type { PluginHost, PluginModuleFactory } from "@openbrf/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { BYLAWS, StandInArchive } from "./stand-in-archive.ts";
import { type StandIn, standIn, type StandInOptions } from "./stand-in-host.ts";

/**
 * The document assistant's route, from the bundle the package ships, mounted
 * as the host mounts it, with the own-key route to Anthropic answering
 * through a stand-in for the host's way out.
 */

const require = createRequire(import.meta.url);
const { createPlugin } = require("../dist/server.cjs") as {
  createPlugin: PluginModuleFactory;
};

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

/** One Messages API answer, calling one tool. */
function calling(name: string, input: unknown) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: `tu_${name}`, name, input },
    ],
    stop_reason: "tool_use",
    stop_details: null,
    usage: { input_tokens: 200, output_tokens: 40 },
  };
}

interface Mounted extends StandIn {
  archive: StandInArchive;
  ask: (body: unknown, language?: string) => Promise<Response>;
}

async function mount(options: StandInOptions = {}): Promise<Mounted> {
  const archive = new StandInArchive();
  const stand = standIn({ actions: archive, ...options });
  const module = await createPlugin(stand.host as unknown as PluginHost);
  const app = await NestFactory.create<NestFastifyApplication>(
    module,
    new FastifyAdapter(),
    { logger: false },
  );
  app.setGlobalPrefix("api/plugin/ai-package");
  await app.listen(0, "127.0.0.1");
  close = () => app.close();
  const { port } = app.getHttpServer().address() as { port: number };
  return {
    ...stand,
    archive,
    ask: (body, language = "sv") =>
      fetch(
        `http://127.0.0.1:${String(port)}/api/plugin/ai-package/documents/ask`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "accept-language": language,
          },
          body: JSON.stringify(body),
        },
      ),
  };
}

describe("the document assistant's route", () => {
  it("answers a question with its sources", async () => {
    const { ask, recipients, archive } = await mount();
    recipients.answer(200, calling("document_get", { id: BYLAWS.id }));
    recipients.answer(
      200,
      calling("give_answer", {
        answer: "Lägst tre och högst sju ledamöter (§ 14).",
        sources: [{ documentId: BYLAWS.id, pages: [2] }],
      }),
    );

    const response = await ask({ question: "  Hur stor får styrelsen vara? " });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: "answered",
      answer: "Lägst tre och högst sju ledamöter (§ 14).",
      sources: [
        {
          id: BYLAWS.id,
          title: BYLAWS.title,
          category: BYLAWS.category,
          audience: BYLAWS.audience,
          pages: [2],
        },
      ],
    });
    // The reads were dispatched with the request the route was serving.
    expect(archive.dispatched).toHaveLength(1);
    expect(archive.dispatched[0]?.request).toBe(archive.listed[0]?.request);
    // The question went to the model without the blanks around it.
    const first = JSON.parse(recipients.sent[0]?.init?.body as string) as {
      messages: { content: unknown }[];
    };
    expect(first.messages[0]?.content).toBe("Hur stor får styrelsen vara?");
    expect(recipients.sent[1]?.init?.disclosure).toEqual({
      personalData: ["freeText", "name"],
      subjects: [],
    });
  });

  it.each([
    ["no body", null],
    ["no question", {}],
    ["a question that is not text", { question: 7 }],
    ["only blanks and invisible characters", { question: " ​ \n" }],
    ["a question too long", { question: "a".repeat(2_001) }],
    ["another field", { question: "Vad står i stadgarna?", model: "x" }],
  ])("refuses %s without calling the model", async (_case, body) => {
    const { ask, recipients } = await mount();

    const response = await ask(body, "en");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      reason: "question-invalid",
      message: "Write a question of at most 2000 characters.",
    });
    expect(recipients.sent).toEqual([]);
  });

  it("refuses a connected app before anything is read, in its language", async () => {
    const { ask, recipients, archive } = await mount({ connectedApp: true });

    const english = await ask({ question: "Vad står i stadgarna?" }, "en-GB");
    const swedish = await ask({ question: "Vad står i stadgarna?" }, "sv-SE");

    expect(english.status).toBe(403);
    expect(await english.json()).toEqual({
      statusCode: 403,
      reason: "connected-app",
      message: "A connected app cannot use the AI package.",
    });
    expect(swedish.status).toBe(403);
    expect(await swedish.json()).toEqual({
      statusCode: 403,
      reason: "connected-app",
      message: "En ansluten app kan inte använda AI-paketet.",
    });
    expect(archive.listed).toEqual([]);
    expect(recipients.sent).toEqual([]);
  });

  it("refuses every request on a host that cannot say whether a connected app sent it", async () => {
    const { ask, recipients, archive } = await mount({
      without: ["actions.client"],
    });

    const response = await ask({ question: "Vad står i stadgarna?" }, "en");

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ reason: "host-unsupported" });
    expect(archive.listed).toEqual([]);
    expect(recipients.sent).toEqual([]);
  });

  it("refuses a question when less than its budget is left of the month", async () => {
    const { ask, recipients } = await mount({
      settings: { monthlyTokenLimit: 100_000 },
    });

    const response = await ask({ question: "Vad står i stadgarna?" }, "en");

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      statusCode: 429,
      reason: "too-little-left",
      message:
        "Less is left of this month's limit for the AI package than one question may use, 250,000 tokens. The assistant works again when the next month starts, or once the limit is raised in the settings.",
    });
    expect(recipients.sent).toEqual([]);
  });

  it("says why there is no answer, in the board member's language", async () => {
    const { ask } = await mount({ entitlement: { status: "absent" } });

    const english = await ask({ question: "Vad står i stadgarna?" }, "en-GB");
    const swedish = await ask({ question: "Vad står i stadgarna?" }, "sv-SE");

    expect(english.status).toBe(403);
    expect(await english.json()).toEqual({
      statusCode: 403,
      reason: "entitlement-required",
      message:
        "The instance holds no active licence for the AI package. Enter one on the licence screen.",
    });
    expect(await swedish.json()).toMatchObject({
      message:
        "Installationen har ingen giltig licens för AI-paketet. Ange en på licenssidan.",
    });
  });

  it.each([
    [{ settings: { apiKey: "" } }, 503, "provider-not-configured"],
    [{ settings: { monthlyTokenLimit: 0 } }, 429, "usage-limit-reached"],
  ] as const)(
    "answers a gateway refusal with its status and reason",
    async (options, status, reason) => {
      const { ask } = await mount(options);

      const response = await ask({ question: "Vad står i stadgarna?" });

      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ reason });
    },
  );

  it("passes on how long to wait when the provider is busy", async () => {
    const { ask, recipients } = await mount();
    recipients.answer(429, { type: "error" }, { "retry-after": "30" });

    const response = await ask({ question: "Vad står i stadgarna?" });

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      reason: "rate-limited",
      retryAfterSeconds: 30,
    });
  });

  it("answers an assistant's refusal with its reason", async () => {
    const { ask, archive, recipients } = await mount();
    archive.offered = [];

    const response = await ask({ question: "Vad står i stadgarna?" });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      reason: "documents-unavailable",
    });
    expect(recipients.sent).toEqual([]);
  });

  it("asks the host for the board, which keeps the archive", async () => {
    const { host } = standIn();
    const module = await createPlugin(host as unknown as PluginHost);
    const controller = (module.controllers ?? []).find(
      (each) => Reflect.getMetadata("path", each as object) === "documents",
    );

    expect(
      Reflect.getMetadata(
        "openbrf:required-capabilities",
        controller as object,
      ),
    ).toEqual(["documents:manage"]);
  });
});
