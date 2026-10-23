import "reflect-metadata";

import { createRequire } from "node:module";

import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import type { PluginHost, PluginModuleFactory } from "@openbrf/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { type StandIn, standIn, type StandInOptions } from "./stand-in-host.ts";
import { LEAK, StandInIssues } from "./stand-in-issues.ts";

/**
 * Issue triage's route, from the bundle the package ships, mounted as the
 * host mounts it, with the own-key route to Anthropic answering through a
 * stand-in for the host's way out.
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

const TRIAGE = {
  summary: "Water is dripping from the bathroom ceiling in 1101.",
  typeId: "type-water",
  categoryReason: "A leak is water and drains, not the laundry room.",
  priority: "urgent",
  priorityReason: "Running water damages the building.",
  replyDraft: "Thank you for your report. We will be in touch.\n\nThe board",
};

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
    usage: { input_tokens: 2_000, output_tokens: 300 },
  };
}

interface Mounted extends StandIn {
  queue: StandInIssues;
  triage: (body: unknown, language?: string) => Promise<Response>;
}

async function mount(options: StandInOptions = {}): Promise<Mounted> {
  const queue = new StandInIssues();
  const stand = standIn({ actions: queue, ...options });
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
    queue,
    triage: (body, language = "sv") =>
      fetch(
        `http://127.0.0.1:${String(port)}/api/plugin/ai-package/issues/triage`,
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

describe("issue triage's route", () => {
  it("answers with suggestions and a draft, and sends nothing else", async () => {
    const { triage, recipients, queue } = await mount();
    recipients.answer(200, calling("give_triage", TRIAGE));

    const response = await triage({ issueId: LEAK.id }, "en");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      issueId: LEAK.id,
      summary: TRIAGE.summary,
      category: {
        suggested: {
          id: "type-water",
          title: "Vatten och avlopp",
          audience: "MEMBER",
        },
        current: {
          id: "type-laundry",
          title: "Tvättstuga",
          audience: "MEMBER",
        },
        reason: TRIAGE.categoryReason,
      },
      priority: { suggested: "urgent", reason: TRIAGE.priorityReason },
      replyDraft: TRIAGE.replyDraft,
    });
    // One call to the model, and the two reads, as the request's person.
    expect(recipients.sent).toHaveLength(1);
    expect(recipients.sent[0]?.init?.disclosure).toEqual({
      personalData: ["name", "apartment", "freeText", "health"],
      subjects: ["person-rut"],
    });
    expect(queue.names()).toEqual(["issue_get", "issue_type_list"]);
    expect(queue.dispatched[0]?.request).toBe(queue.listed[0]?.request);
    expect(queue.proposed).toEqual([]);
    // The model was offered the triage tool alone.
    const sent = JSON.parse(recipients.sent[0]?.init?.body as string) as {
      tools: { name: string }[];
    };
    expect(sent.tools.map((tool) => tool.name)).toEqual(["give_triage"]);
  });

  it.each([
    ["no body", null],
    ["no issue", {}],
    ["an id that is not text", { issueId: 7 }],
    ["an empty id", { issueId: "" }],
    ["an id with a blank in it", { issueId: "issue leak" }],
    ["an id too long", { issueId: "a".repeat(65) }],
    ["another field", { issueId: LEAK.id, send: true }],
  ])("refuses %s without reading or calling anything", async (_case, body) => {
    const { triage, recipients, queue } = await mount();

    const response = await triage(body, "en");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      reason: "issue-id-invalid",
      message: "Name the issue to triage by its id.",
    });
    expect(queue.listed).toEqual([]);
    expect(recipients.sent).toEqual([]);
  });

  it("answers an issue the person cannot read as not found", async () => {
    const { triage, recipients } = await mount();

    const response = await triage({ issueId: "issue-elsewhere" }, "sv");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      statusCode: 404,
      reason: "issue-not-found",
      message:
        "Det finns inget ärende med det id:t som du kan få förslag för här.",
    });
    expect(recipients.sent).toEqual([]);
  });

  it("refuses a connected app before anything is read", async () => {
    const { triage, recipients, queue } = await mount({ connectedApp: true });

    const response = await triage({ issueId: LEAK.id }, "en");

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: "connected-app" });
    expect(queue.listed).toEqual([]);
    expect(recipients.sent).toEqual([]);
  });

  it("refuses a triage when less than its budget is left of the month", async () => {
    const { triage, recipients } = await mount({
      settings: { monthlyTokenLimit: 39_999 },
    });

    const response = await triage({ issueId: LEAK.id }, "en");

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      statusCode: 429,
      reason: "too-little-left",
      message:
        "Less is left of this month's limit for the AI package than one triage may use, 40,000 tokens. Triage works again when the next month starts only if the monthly limit is at least 40,000 tokens. A lower limit must be raised in the settings to at least that.",
    });
    expect(recipients.sent).toEqual([]);
  });

  it("answers a host without the type catalogue as unavailable", async () => {
    const { triage, recipients, queue } = await mount();
    queue.offered = queue.offered.filter(
      (action) => action.name !== "issue_type_list",
    );

    const response = await triage({ issueId: LEAK.id }, "en");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      reason: "issues-unavailable",
    });
    expect(recipients.sent).toEqual([]);
  });

  it("answers a gateway refusal with its status and reason", async () => {
    const { triage } = await mount({ entitlement: { status: "absent" } });

    const response = await triage({ issueId: LEAK.id }, "en");

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      reason: "entitlement-required",
    });
  });

  it("asks the host for the board: who handles issues and configures their types", async () => {
    const { host } = standIn();
    const module = await createPlugin(host as unknown as PluginHost);
    const controller = (module.controllers ?? []).find(
      (each) => Reflect.getMetadata("path", each as object) === "issues",
    );

    expect(
      Reflect.getMetadata(
        "openbrf:required-capabilities",
        controller as object,
      ),
    ).toEqual(["issues:handle", "issues:configure"]);
  });
});
