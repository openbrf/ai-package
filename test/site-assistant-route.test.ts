import "reflect-metadata";

import { createRequire } from "node:module";

import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import type { PluginHost, PluginModuleFactory } from "@openbrf/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { StandInActions } from "./stand-in-actions.ts";
import { type StandIn, standIn, type StandInOptions } from "./stand-in-host.ts";

/**
 * The site and news assistant's route, from the bundle the package ships,
 * mounted as the host mounts it, with the model reached through the Anthropic
 * adapter and a stand-in for the host's way out.
 */

const require = createRequire(import.meta.url);
const { createPlugin } = require("../dist/server.cjs") as {
  createPlugin: PluginModuleFactory;
};

const TURN_ID = "7d1f3a52-3c4b-4d7e-9a1b-2c3d4e5f6a7b";

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

/** An answer from the Messages API, as the adapter reads one. */
function wire(content: unknown[], stopReason: string) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_details: null,
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

async function serve(
  options: StandInOptions = {},
): Promise<StandIn & { actions: StandInActions; url: string }> {
  const stand = standIn(options);
  const actions = new StandInActions();
  const host = {
    ...stand.host,
    actions: { ...actions.asHost(), client: stand.host.actions.client },
  };
  const module = await createPlugin(host as unknown as PluginHost);
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
    host,
    actions,
    url: `http://127.0.0.1:${String(port)}/api/plugin/ai-package/assistants/site/turns`,
  };
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const TURN = {
  turnId: TURN_ID,
  sentAt: new Date().toISOString(),
  messages: [{ role: "user", text: "Skriv en nyhet om städdagen." }],
};

describe("the site assistant's route", () => {
  it("proposes the model's write and answers with the link to confirm it", async () => {
    const { url, recipients, actions } = await serve();
    recipients.answer(
      200,
      wire(
        [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "news_create",
            input: { slug: "staddag", title: "Städdag", blocks: [] },
          },
        ],
        "tool_use",
      ),
    );
    recipients.answer(
      200,
      wire(
        [{ type: "text", text: "Nyheten väntar på din bekräftelse." }],
        "end_turn",
      ),
    );

    const response = await post(url, TURN);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
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
    expect(actions.written).toEqual([]);
    // Each call names the personal data it may carry, and nobody.
    expect(recipients.sent[0]?.init?.disclosure).toEqual({
      personalData: ["name", "freeText"],
      subjects: [],
    });
  });

  it("refuses a connected app, and calls nothing", async () => {
    const { url, recipients, actions } = await serve({ connectedApp: true });

    const response = await post(url, TURN);

    expect(response.status).toBe(403);
    expect(recipients.sent).toEqual([]);
    expect(actions.listed).toEqual([]);
  });

  it("runs nothing on a host that cannot say whether a connected app asked", async () => {
    const { url, recipients, actions } = await serve({
      without: ["actions.client"],
    });

    const response = await post(url, TURN);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "host-unsupported" });
    expect(recipients.sent).toEqual([]);
    expect(actions.listed).toEqual([]);
  });

  it.each([
    ["no turn id", { messages: TURN.messages }],
    ["a turn id that is not one", { ...TURN, turnId: "turn-1" }],
    ["no time it was first sent", { turnId: TURN_ID, messages: TURN.messages }],
    ["a time that is not one", { ...TURN, sentAt: "2026-10-22" }],
    ["a time that is no date", { ...TURN, sentAt: "2026-02-30T09:41:12.000Z" }],
    [
      "a time without milliseconds",
      { ...TURN, sentAt: "2026-10-22T09:41:12Z" },
    ],
    ["no conversation", { turnId: TURN_ID, sentAt: TURN.sentAt }],
    [
      "a conversation ending with the assistant",
      {
        turnId: TURN_ID,
        sentAt: TURN.sentAt,
        messages: [
          { role: "user", text: "Hej" },
          { role: "assistant", text: "Hej" },
        ],
      },
    ],
  ])("refuses a request with %s", async (_case, body) => {
    const { url, recipients } = await serve();

    expect((await post(url, body)).status).toBe(400);
    expect(recipients.sent).toEqual([]);
  });

  it("asks the host for the board's grant for the news and the pages", async () => {
    const { host } = standIn();
    const module = await createPlugin(host as unknown as PluginHost);
    const controller = (module.controllers ?? []).find(
      (held) => Reflect.getMetadata("path", held) === "assistants/site",
    );

    expect(
      Reflect.getMetadata(
        "openbrf:required-capabilities",
        controller as object,
      ),
    ).toEqual(["site:manage"]);
  });
});
