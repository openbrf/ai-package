import {
  Controller,
  type DynamicModule,
  ForbiddenException,
  Get,
  Module,
  Req,
  SetMetadata,
} from "@nestjs/common";
import type {
  ActionRequest,
  PluginHost,
  PluginModuleFactory,
} from "@openbrf/plugin-sdk";

import { AiGateway, type AiStatus } from "./gateway.ts";
import type { AiPackageHost } from "./host-contract.ts";

/**
 * The AI package's server entry point.
 *
 * It builds the gateway the assistants reach a model through and serves one
 * route, `status`, which the board's screen reads: the licence finding, the
 * provider and model, whether a key is entered, and this month's use against
 * the limit. The assistants themselves come in later releases.
 *
 * The controllers take no constructor arguments: they close over the host
 * object instead. The bundler that builds this file does not emit the
 * metadata NestJS would need to inject one.
 */

/**
 * The metadata key the host reads a route's required capabilities from, as
 * the host's `@RequireCapability` writes it. The SDK release this builds
 * against exports no decorator for it.
 */
const REQUIRED_CAPABILITIES = "openbrf:required-capabilities";

export const createPlugin: PluginModuleFactory = (
  pluginHost: PluginHost,
): DynamicModule => {
  const host = pluginHost as unknown as AiPackageHost;
  const gateway = new AiGateway(host);

  /**
   * `association:read`, as the instance's plugin list is: the board answers
   * for how the instance is configured, and reads it without being able to
   * change it. The package declares no permission, so without this its
   * routes are held to `self:manage`, which every resident has.
   *
   * A connected app is refused even with a capability that would admit it:
   * the licence, the limit and the month's use are the board's to read.
   */
  @Controller("status")
  @SetMetadata(REQUIRED_CAPABILITIES, ["association:read"])
  class StatusController {
    @Get()
    async get(@Req() request: ActionRequest): Promise<AiStatus> {
      // A host without `actions.client` cannot say who sent the request. The
      // route is behind its session guard all the same.
      const app = host.actions.client?.(request) ?? null;
      if (app !== null) {
        throw new ForbiddenException();
      }
      return gateway.status();
    }
  }

  @Module({})
  class AiPackageModule {}

  return {
    module: AiPackageModule,
    controllers: [StatusController],
  };
};
