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

/**
 * Meeting support's two routes, from the bundle the package ships, mounted
 * under the package's prefix as the host mounts them, with the own-key route
 * to Anthropic answering through a stand-in for the host's way out.
 */

const require = createRequire(import.meta.url);
const { createPlugin } = require("../dist/server.cjs") as {
  createPlugin: PluginModuleFactory;
};

const MEETING = {
  id: "meeting-2027",
  kind: "ORDINARY",
  heldOn: "2027-05-20",
  concludedAt: null,
  summoned: false,
  agendaItemCount: 0,
  agenda: [],
  notice: null,
};

/** A Messages API answer whose text is `text`. */
function message(text: string) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_details: null,
    usage: { input_tokens: 400, output_tokens: 80 },
  };
}

const AGENDA = JSON.stringify({
  items: [{ title: "Stämmans öppnande" }, { title: "Stämmans avslutande" }],
  note: "Utan förra årets dagordning.",
});

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve(
  options: StandInOptions = {},
  meeting: Record<string, unknown> = MEETING,
): Promise<
  StandIn & {
    post: (
      path: string,
      body: unknown,
      headers?: Record<string, string>,
    ) => Promise<Response>;
  }
> {
  const stand = standIn(options);
  stand.meetingActions.answers.set("meeting_get", () => meeting);
  stand.meetingActions.answers.set("meeting_list", () => ({
    meetings: [meeting],
    more: false,
  }));
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
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(
      `http://127.0.0.1:${String(port)}/api/plugin/ai-package/meetings/${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      },
    );
  return { ...stand, post };
}

function sentBody(stand: StandIn): Record<string, unknown> {
  return JSON.parse(stand.recipients.sent[0]?.init?.body as string) as Record<
    string,
    unknown
  >;
}

describe("the meeting support routes", () => {
  it("ask the host for the board's meetings capability", async () => {
    const { host } = standIn();
    const module = await createPlugin(host as unknown as PluginHost);
    const controller = (module.controllers ?? []).find(
      (candidate) => Reflect.getMetadata("path", candidate) === "meetings",
    );

    expect(controller).toBeDefined();
    expect(
      Reflect.getMetadata(
        "openbrf:required-capabilities",
        controller as object,
      ),
    ).toEqual(["meetings:manage"]);
  });

  it("answer an agenda draft with the pending change to confirm", async () => {
    const stand = await serve();
    stand.recipients.answer(200, message(AGENDA));

    const response = await stand.post(`${MEETING.id}/agenda-draft`, {
      instructions: "Ta med motionerna.",
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      items: [{ title: "Stämmans öppnande" }, { title: "Stämmans avslutande" }],
      note: "Utan förra årets dagordning.",
      pendingChange: {
        id: "pending-1",
        expiresAt: "2026-10-29T09:41:12.000Z",
        path: "/app/pending-changes/pending-1",
      },
    });
    expect(stand.meetingActions.proposed[0]?.name).toBe("meeting_set_agenda");
    expect(sentBody(stand).output_config).toMatchObject({
      format: { type: "json_schema" },
    });
  });

  it("draft in the language the request asks for, unless the body names one", async () => {
    const english = await serve();
    english.recipients.answer(200, message(AGENDA));
    await english.post(
      `${MEETING.id}/agenda-draft`,
      {},
      {
        "accept-language": "en-GB,en;q=0.9",
      },
    );
    expect(sentBody(english).system).toContain("in English");
    await close?.();

    const swedish = await serve();
    swedish.recipients.answer(200, message(AGENDA));
    await swedish.post(
      `${MEETING.id}/agenda-draft`,
      { language: "sv" },
      {
        "accept-language": "en-GB",
      },
    );
    expect(sentBody(swedish).system).toContain("in Swedish");
  });

  it("answer a minutes draft with the text and keep nothing", async () => {
    const stand = await serve();
    stand.recipients.answer(200, message("PROTOKOLL"));

    const response = await stand.post(`${MEETING.id}/minutes-draft`, {
      notes: "Mötet öppnades 18.00.",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      draft: "PROTOKOLL",
      complete: true,
    });
    expect(stand.meetingActions.proposed).toHaveLength(0);
  });

  it.each([
    ["agenda-draft", { instructions: "x", position: 1 }],
    ["agenda-draft", { instructions: "x".repeat(2001) }],
    ["minutes-draft", {}],
    ["minutes-draft", { notes: "   " }],
    ["minutes-draft", { notes: "x".repeat(50_001) }],
    ["minutes-draft", { notes: "Anteckningar", language: "de" }],
  ])("refuse a %s body the route does not take", async (route, body) => {
    const stand = await serve();

    const response = await stand.post(`${MEETING.id}/${route}`, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ reason: "invalid-body" });
    expect(stand.recipients.sent).toHaveLength(0);
  });

  it.each(["agenda-draft", "minutes-draft"])(
    "refuse a connected app on %s before anything is read",
    async (route) => {
      const stand = await serve({ connectedApp: true });

      const response = await stand.post(`${MEETING.id}/${route}`, {
        notes: "Anteckningar",
      });

      expect(response.status).toBe(403);
      expect(stand.meetingActions.invoked).toHaveLength(0);
      expect(stand.recipients.sent).toHaveLength(0);
    },
  );

  it("answer an agenda draft for a summoned meeting with a conflict", async () => {
    const stand = await serve({}, { ...MEETING, summoned: true });

    const response = await stand.post(`${MEETING.id}/agenda-draft`, {});

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ reason: "notice-already-issued" });
    expect(stand.recipients.sent).toHaveLength(0);
  });

  it("refuse notes holding a personal identity number before anything is sent", async () => {
    const stand = await serve();

    const response = await stand.post(`${MEETING.id}/minutes-draft`, {
      notes: "Ny medlem: 811228-9874.",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      reason: "personal-identity-number",
    });
    expect(stand.recipients.sent).toHaveLength(0);
  });

  it.each([
    ["agenda-draft", {}],
    ["minutes-draft", { notes: "Mötet öppnades 18.00." }],
  ])(
    "refuse a %s whose meeting record holds a personal identity number before anything is sent",
    async (route, body) => {
      const stand = await serve(
        {},
        {
          ...MEETING,
          agendaItemCount: 1,
          agenda: [
            {
              id: "item-a",
              position: 1,
              title: "Motion från Anna Berg, 811228-9874",
              decision: null,
            },
          ],
        },
      );

      const response = await stand.post(`${MEETING.id}/${route}`, body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        reason: "personal-identity-number",
      });
      expect(stand.recipients.sent).toHaveLength(0);
    },
  );

  it.each([
    ["agenda-draft", {}, AGENDA],
    ["minutes-draft", { notes: "Mötet öppnades 18.00." }, "PROTOKOLL"],
  ])(
    "tell the host a %s carries every category the manifest declares",
    async (route, body, text) => {
      const stand = await serve();
      stand.recipients.answer(200, message(text));

      await stand.post(`${MEETING.id}/${route}`, body);

      expect(stand.recipients.sent[0]?.init?.disclosure).toEqual({
        personalData: ["name", "apartment", "freeText", "health"],
        subjects: [],
      });
    },
  );

  it("answer a draft past the month's limit as too many", async () => {
    const stand = await serve({ settings: { monthlyTokenLimit: 0 } });

    const response = await stand.post(`${MEETING.id}/minutes-draft`, {
      notes: "Anteckningar",
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ reason: "usage-limit-reached" });
  });

  it("answer an agenda the model could not draft as unprocessable", async () => {
    const stand = await serve();
    stand.recipients.answer(200, message("Ingen dagordning."));

    const response = await stand.post(`${MEETING.id}/agenda-draft`, {});

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ reason: "no-draft" });
    expect(stand.meetingActions.proposed).toHaveLength(0);
  });
});
