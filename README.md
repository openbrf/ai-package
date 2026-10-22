# AI package for Open BRF

An [Open BRF](https://github.com/openbrf/openbrf) plugin that gives a housing
cooperative's board assistants built on a language model, on the association's
own model provider account and within a monthly limit the board sets.

This release is the package's foundation: the settings, the way to the model,
the licence check, and the limits. The assistants come in later releases.

## How it works

- **One way to a model.** Every assistant reaches the model through one
  gateway, `src/gateway.ts`. Before each call it checks, in this order, that the
  instance is new enough, that the instance holds an active licence for the AI
  package, that the board has entered an API key, and that the call is within
  the monthly limit and the per-minute limit. Then it calls the provider and
  counts what the call used. The assistant gets the model's answer, or is told
  why there is none: `host-unsupported`, `entitlement-required`,
  `provider-not-configured`, `usage-limit-reached`, `rate-limited` (here or at
  the provider) or `provider-failed`. A call that fails a check is not made.
- **A provider interface.** The assistants are written against the package's
  own interface, `src/provider.ts`: a system prompt, a conversation, tools the
  model may ask to call, and a limit on the answer. They never see a provider's
  wire format, so the route to a model can change without them. This release
  has one route, the association's own Anthropic API key (`src/anthropic.ts`),
  and the settings offer no choice of route. The gateway takes its route as a
  constructor option (`route` in `AiGatewayOptions`), which is where a second
  provider would come in. A route hosted by Apteo, which would authenticate
  with the instance's licence rather than a key, is left to a later release.
- **Through the host's way out.** The Anthropic adapter sends every request
  through `host.recipients.fetch` to the recipient the manifest declares,
  `https://api.anthropic.com` (ADR 0037 in openbrf/openbrf). The host applies
  the instance's outbound address rules, and records each disclosure of
  personal data, per person, before and after the request is sent. That is why
  the adapter speaks the Messages API over HTTP rather than through Anthropic's
  SDK, which would open a connection of its own. Every call says which personal
  data it carries and about whom, or that it carries none: the gateway takes no
  call without that answer.
- **Claude's own fallback.** Requests to Claude Opus 5.5 and Claude Sonnet 5.5
  ask for Anthropic's server-side fallback: a request the model declines on
  policy grounds is run again, in the same call and on the same key, on the
  model Anthropic recommends for that kind of decline. Claude Haiku 5.5 has
  none. A request that is declined all the same comes back with the stop reason
  `refusal`.

## Settings

The board enters these on the plugin's settings screen:

| Setting           | What it is                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic API key | The association's own key. A secret setting: never shown again once saved, stored encrypted, and handed in clear only to the package on the server. |
| Model             | Claude Opus 5.5 (the default), Claude Sonnet 5.5 or Claude Haiku 5.5.                                                                               |
| Monthly limit     | Tokens per calendar month in Stockholm, sent and received together. 2,000,000 by default; 0 stops every call.                                       |
| Calls per minute  | For the whole association. 10 by default, at most 120.                                                                                              |

The settings are read again on every call, so a change bites on the next one.

### The limits

The month's totals, each call's token counts and the current minute's count are
kept in the package's own records (ADR 0033 in openbrf/openbrf), so every
process serving the instance counts against the same figures. They say nothing
about a person: no record holds who asked or what for.

The monthly limit is checked before each call, and a call already under way is
let finish. A month can therefore end over its limit by what the calls under way
at that moment used, and the per-minute limit bounds how many those are.

When a call finishes, what it used is written first as a record of its own,
which no other call writes to, and then added to the month's totals. Many calls
finishing at once compete for the totals, and a call that loses that race
leaves its record for a later call to add. Until then the month is read as its
totals plus the calls they do not include yet, so the limit counts every call
whose record was written. A call goes uncounted only if the process stops, or
the store refuses the write, between the provider's answer and that record; a
refused write fails the call. A record added to the totals and not yet deleted
is not counted twice.

## Data protection

The assistants send the association's text to Anthropic: issue reports,
messages from residents and the board's own drafts. That text can name
residents and their apartments, and residents sometimes write about their
health. The manifest declares this for the board to read on the consent screen
before the package is installed: the personal-data categories `name`,
`apartment`, `freeText` and `health`, and the one recipient that receives them.

The association brings its own API key, so the association is the controller
and Anthropic its processor, under the agreement the association accepted with
its own Anthropic account. When the board installs the package, the consent
screen asks it to classify the recipient; for this package the answer is
processor. The association's record of processing activities and its privacy
notice should name Anthropic as a recipient.

## Licence

The AI package is a paid module. It reads the instance's licence through
`host.entitlements` (ADR 0042 in openbrf/openbrf). The licence is a signed file
the board enters on the instance's licence screen, and the host verifies it
offline. Without an active `ai-package` entitlement the package makes no model
calls. Nothing is switched off: once a licence is entered, the package works as
before.

A host without `host.entitlements`, `host.recipients` or `host.records` is older
than the package, which makes no calls there.

The issuer key in `package.json` is a placeholder whose private half was never
kept. No licence verifies against it until Apteo's issuing key replaces it.

The code is licensed under the [AGPL-3.0](LICENSE).

## The status route

`GET /api/plugin/ai-package/status` answers with the licence finding, the
provider and model, whether a key is entered (never the key), this month's use
and the two limits. It requires `association:read`, the board's reading of how
the instance is configured, and refuses a connected app.

## Development

```sh
pnpm install
pnpm test            # builds dist/server.cjs and runs the tests
pnpm typecheck
pnpm build && pnpm check:package
```

`pnpm test` runs the gateway against a fake provider and the Anthropic adapter
against a stand-in for the host's way out, with the package's records in
memory. It also loads the bundle the package ships into a NestJS application on
Fastify and reads the status route.

The server entry point is one CommonJS bundle, `dist/server.cjs`, whose only
externals are `@nestjs/common` and Node's built-ins. `pnpm check:package` runs
the SDK's `pluginPackageProblems` over the packed tarball, as the catalog does
before it lists a release.

### Host members newer than the SDK release

The package builds against `@openbrf/plugin-sdk` 1.0.0. `host.recipients`,
`host.records`, `host.entitlements`, `host.actions.client` and the secret
setting came later. `src/host-contract.ts` declares them as the SDK does, and
the package checks for each one at run time, because an older host does not
have it. Replace those declarations with the SDK's own exports once a release
carries them.

The SDK 1.0.0 also cannot check this manifest: it refuses the secret setting and
the shared personal-data categories. Until a release can, run the package check
against the SDK's source:

```sh
node scripts/plugin-sdk-from-source.mjs <checkout of openbrf/openbrf> /tmp/plugin-sdk.mjs
OPENBRF_PLUGIN_SDK=/tmp/plugin-sdk.mjs pnpm check:package
```

CI does this against a pinned commit of openbrf/openbrf.

## Contributing

Contributions are welcome under the
[Open BRF contributor licence agreement](https://github.com/openbrf/openbrf/blob/main/CLA.md).
Commit messages and pull request titles follow
[Conventional Commits](https://www.conventionalcommits.org/).
