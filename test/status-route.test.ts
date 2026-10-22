import "reflect-metadata";

import { createRequire } from "node:module";

import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import type { PluginHost, PluginModuleFactory } from "@openbrf/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { standIn, type StandInOptions } from "./stand-in-host.ts";

/**
 * The route the board's screen reads, from the bundle the package ships,
 * mounted under the package's prefix in a NestJS application on Fastify as
 * the host mounts it.
 *
 * Who may read it is the host's guard, which reads the capabilities the route
 * declares; that the route declares the right ones is what is tested here.
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

async function readStatus(options: StandInOptions = {}): Promise<Response> {
  const { host } = standIn(options);
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
  return fetch(`http://127.0.0.1:${String(port)}/api/plugin/ai-package/status`);
}

describe("the status route", () => {
  it("answers with the licence, the provider, the limits and the month's use", async () => {
    const response = await readStatus({
      settings: { model: "claude-sonnet-5-5" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      hostSupported: true,
      licence: { status: "active" },
      provider: {
        name: "Anthropic",
        model: "claude-sonnet-5-5",
        keyEntered: true,
      },
      usage: { tokens: 0, calls: 0 },
      monthlyTokenLimit: 2_000_000,
      requestsPerMinute: 10,
    });
    expect(JSON.stringify(body)).not.toContain("sk-ant-test-key");
  });

  it("refuses a connected app, which learns nothing about the licence or the use", async () => {
    const response = await readStatus({ connectedApp: true });

    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).not.toContain("active");
    expect(text).not.toContain("Anthropic");
  });

  it("asks the host for the board's reading of the configuration", async () => {
    const { host } = standIn();
    const module = await createPlugin(host as unknown as PluginHost);
    const [controller] = module.controllers ?? [];

    expect(Reflect.getMetadata("path", controller as object)).toBe("status");
    expect(
      Reflect.getMetadata(
        "openbrf:required-capabilities",
        controller as object,
      ),
    ).toEqual(["association:read"]);
  });
});
