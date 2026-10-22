import { anthropicProvider } from "./anthropic.ts";
import type {
  AiPackageHost,
  EntitlementState,
  PluginDisclosure,
  PluginRecipients,
  PluginRecords,
} from "./host-contract.ts";
import {
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  ProviderFailure,
  type ProviderFailureReason,
  totalTokens,
} from "./provider.ts";
import { type AiSettings, aiSettings } from "./settings.ts";
import { UsageMeter } from "./usage.ts";

/**
 * The one way the package's assistants reach a model.
 *
 * Before every call it checks, in this order, that the host has what the
 * package needs, that the instance holds an active `ai-package` licence, that
 * the board has entered a key, and that the call is within the monthly limit
 * and the per-minute limit. Then it calls the provider and counts what the
 * call used. An assistant gets the model's answer or an `AiRefusal` saying
 * which check failed, and never reaches a provider any other way.
 */

/**
 * Why the gateway made no call, or the call gave no answer.
 *
 * - `host-unsupported`: the instance is older than the package.
 * - `entitlement-required`: no active licence for the AI package (ADR 0042).
 * - `provider-not-configured`: the board has entered no API key.
 * - `usage-limit-reached`: this month's limit is used up.
 * - `rate-limited`: too many calls this minute, here or at the provider.
 * - `provider-failed`: the provider gave no answer; `providerReason` says why.
 */
export type AiRefusalReason =
  | "host-unsupported"
  | "entitlement-required"
  | "provider-not-configured"
  | "usage-limit-reached"
  | "rate-limited"
  | "provider-failed";

export class AiRefusal extends Error {
  constructor(
    readonly reason: AiRefusalReason,
    /** When trying again could work, in seconds, if anyone said. */
    readonly retryAfterSeconds: number | null = null,
    /** For `provider-failed` and a provider's `rate-limited`, its reason. */
    readonly providerReason: ProviderFailureReason | null = null,
  ) {
    super(`The AI package has no answer from the model: ${reason}.`);
    this.name = "AiRefusal";
  }
}

/**
 * The route to a model, chosen from the board's settings.
 *
 * Today there is one: the association's own key with Anthropic. A route hosted
 * by Apteo would be a second provider chosen here, declared as a second
 * recipient and authenticated with `host.entitlements.present(audience)`
 * rather than a key; nothing an assistant calls would change.
 */
export type ProviderRoute = (
  settings: AiSettings,
  recipients: PluginRecipients,
) => ModelProvider | null;

export const ownKeyRoute: ProviderRoute = (settings, recipients) =>
  settings.apiKey === null
    ? null
    : anthropicProvider(recipients, settings.apiKey, settings.model);

export interface AiGatewayOptions {
  readonly route?: ProviderRoute;
  readonly now?: () => Date;
}

/** What the board's screen shows about the package. */
export interface AiStatus {
  /** False on an instance older than the package, which makes no calls. */
  readonly hostSupported: boolean;
  readonly licence: EntitlementState | null;
  readonly provider: {
    readonly name: string;
    readonly model: string;
    readonly keyEntered: boolean;
  };
  readonly usage: {
    readonly month: string;
    readonly tokens: number;
    readonly calls: number;
  } | null;
  readonly monthlyTokenLimit: number;
  readonly requestsPerMinute: number;
}

/** The most `maxOutputTokens` may ask for, the models' own limit. */
const MAX_OUTPUT_TOKENS = 128_000;

interface SupportedHost {
  readonly recipients: PluginRecipients;
  readonly records: PluginRecords;
}

export class AiGateway {
  private readonly route: ProviderRoute;
  private readonly now: () => Date;

  constructor(
    private readonly host: AiPackageHost,
    options: AiGatewayOptions = {},
  ) {
    this.route = options.route ?? ownKeyRoute;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * One call to the model.
   *
   * `disclosure` names the personal data the request carries and whom it is
   * about, or is null when it carries none. It is required rather than
   * optional so that every assistant says which: the host records a
   * disclosure per person, and a request that should have named one and did
   * not is recorded nowhere.
   */
  async complete(
    request: ModelRequest,
    disclosure: PluginDisclosure | null,
  ): Promise<ModelResponse> {
    if (
      !Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 1 ||
      request.maxOutputTokens > MAX_OUTPUT_TOKENS
    ) {
      throw new RangeError(
        `maxOutputTokens must be a whole number from 1 to ${String(MAX_OUTPUT_TOKENS)}.`,
      );
    }

    const host = this.supported();
    if (host === null) {
      throw new AiRefusal("host-unsupported");
    }
    if ((await this.licence())?.status !== "active") {
      throw new AiRefusal("entitlement-required");
    }
    const settings = aiSettings(await this.host.settings.read());
    const provider = this.route(settings, host.recipients);
    if (provider === null) {
      throw new AiRefusal("provider-not-configured");
    }

    const meter = new UsageMeter(host.records, this.now);
    const admission = await meter.admit(settings);
    if (!admission.admitted) {
      throw admission.reason === "rate-limited"
        ? new AiRefusal("rate-limited", admission.retryAfterSeconds)
        : new AiRefusal("usage-limit-reached");
    }

    let response: ModelResponse;
    try {
      response = await provider.complete({ request, disclosure });
    } catch (cause) {
      if (!(cause instanceof ProviderFailure)) {
        throw cause;
      }
      // The reason and the status only: the failure's cause may carry what
      // was sent, and the log is no place for it.
      this.host.logger.warn(
        `${provider.name} gave no answer: ${cause.reason}` +
          (cause.status === null ? "." : ` (HTTP ${String(cause.status)}).`),
      );
      if (cause.usage !== null) {
        await this.count(meter, cause.usage);
      }
      throw new AiRefusal(
        cause.reason === "rate-limited" ? "rate-limited" : "provider-failed",
        cause.retryAfterSeconds,
        cause.reason,
      );
    }
    await this.count(meter, response.usage);
    return response;
  }

  /** The licence, the key, the model and this month's use, for the board. */
  async status(): Promise<AiStatus> {
    const host = this.supported();
    const settings = aiSettings(await this.host.settings.read());
    const provider =
      host === null ? null : this.route(settings, host.recipients);
    const usage =
      host === null
        ? null
        : await new UsageMeter(host.records, this.now).thisMonth();
    return {
      hostSupported: host !== null,
      licence: await this.licence(),
      provider: {
        name: provider?.name ?? "Anthropic",
        model: provider?.model ?? settings.model,
        keyEntered: settings.apiKey !== null,
      },
      usage:
        usage === null
          ? null
          : {
              month: usage.month,
              tokens: totalTokens(usage.usage),
              calls: usage.usage.calls,
            },
      monthlyTokenLimit: settings.monthlyTokenLimit,
      requestsPerMinute: settings.requestsPerMinute,
    };
  }

  /**
   * The host's members this package cannot work without, or null on a host
   * older than them. Read on every call, not once: the host object is late
   * bound.
   */
  private supported(): SupportedHost | null {
    const { recipients, records, entitlements } = this.host;
    if (
      recipients === undefined ||
      records === undefined ||
      entitlements === undefined
    ) {
      return null;
    }
    return { recipients, records };
  }

  /**
   * The licence finding, or null on a host without `host.entitlements`,
   * which cannot tell a licensed instance from one that is not: the package
   * makes no calls there.
   */
  private async licence(): Promise<EntitlementState | null> {
    return (await this.host.entitlements?.get()) ?? null;
  }

  private async count(
    meter: UsageMeter,
    used: Parameters<UsageMeter["record"]>[0],
  ): Promise<void> {
    if (!(await meter.record(used))) {
      this.host.logger.error(
        "A model call's use could not be counted towards the monthly limit: " +
          "every attempt to write it lost to another writer.",
      );
    }
  }
}
