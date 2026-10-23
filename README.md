# AI package for Open BRF

An [Open BRF](https://github.com/openbrf/openbrf) plugin that gives a housing
cooperative's board assistants built on a language model, on the association's
own model provider account and within a monthly limit the board sets.

The package holds the settings, the way to the model, the licence check and
the limits, and its first assistant: meeting support, which drafts a general
meeting's agenda and its minutes. The other assistants come in later releases.

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

## Meeting support

Two drafts for a general meeting (föreningsstämma), for a board member holding
`meetings:manage`, the capability the platform's own meetings screen requires.
Both read the meeting through the platform's own actions, `meeting_list` and
`meeting_get`: the day, the kind, the agenda, each decision's outcome and vote
totals, and the notice's time and place. Neither action returns a person: not
who attended, not the proxy authorisations, not how anybody voted. The model is
offered no tools. It reads what the package hands it and answers with a draft,
so text in a meeting's record or in the notes can change a draft and nothing
else.

- **An agenda draft** (`POST /api/plugin/ai-package/meetings/:meetingId/agenda-draft`,
  with optional `instructions` and `language`). The draft starts from the
  agenda of the last meeting of the same kind that was held, or, for an
  ordinary meeting without one, from the matters model bylaws usually list.
  The motions put to the meeting are read through `motion_meeting_list`: each
  one's title and whether the board has acknowledged it, never who submitted
  it. The draft gives each motion an item of its own. On an instance without
  that action, or for a board member who does not hold `motions:handle`, the
  draft says where the motions belong instead. The draft is proposed as
  `meeting_set_agenda`, a pending change: nothing is written
  until the board member confirms it on the platform's own screen, at the
  `path` the answer gives, and they can reject it there. The proposal names the
  agenda it was drafted against, so a draft confirmed after somebody rewrote the
  agenda is refused rather than written over. It is refused before the model is
  called once the notice has been issued or the meeting has been recorded as
  held, because the agenda can then no longer change.
- **A minutes draft** (`POST /api/plugin/ai-package/meetings/:meetingId/minutes-draft`,
  with `notes` and an optional `language`). The board member's notes and the
  meeting's record become a draft of the minutes, item by item, with the
  decisions as recorded. The draft is handed back and kept nowhere, here or in
  the archive. The board corrects it, has it signed and files it as before.

A draft is written in the language the body names, `sv` or `en`, or else the
request's. A connected app is refused both routes. A refusal answers with a
`reason`: `notice-already-issued` or `meeting-already-held` (409), `no-draft`
when the model declined or gave no usable draft (422),
`personal-identity-number` when the request or the notes hold one, which is
then not sent anywhere (400), the gateway's reasons
(see above), and `host-unsupported` (501) on an instance without
`meeting_set_agenda` or pending changes. The platform's own refusals, such as
`meeting-not-found`, come back as the platform gives them.

The routes are the server half of meeting support. The board's screen for them
comes with the package's first view.

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
totals plus the calls they do not include yet, and a record added to the totals
and not yet deleted is not counted twice. While other calls keep adding to the
totals during every attempt to read them, the month is instead read in a way
that may count a call twice, which errs towards the limit. Either way the limit
counts every call whose record was written before the check. A call goes
uncounted only if the process stops, or the store refuses the write, between
the provider's answer and that record; a refused write fails the call.

## Data protection

The assistants send the association's text to Anthropic: issue reports,
messages from residents and the board's own drafts. Meeting support sends a
meeting's agenda, its decisions as totals, the notice's time and place, the
titles of the motions put to it, and the board member's request or notes,
which can name the members who spoke or were elected. That text can name residents and their apartments, and residents
sometimes write about their health. The manifest declares this for the board to read on the consent screen
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
pnpm build
```

`pnpm test` runs the gateway and meeting support against a fake provider and
the Anthropic adapter against a stand-in for the host's way out, with the
package's records in memory and the platform's meeting actions stood in for. It
also loads the bundle the package ships into a NestJS application on Fastify
and calls the status route and the meeting support routes.

The server entry point is one CommonJS bundle, `dist/server.cjs`, whose only
externals are `@nestjs/common` and Node's built-ins. `pnpm check:package` runs
the SDK's `pluginPackageProblems` over the packed tarball, as the catalog does
before it lists a release. With the SDK 1.0.0 it refuses this manifest, so run
it as described below.

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
pnpm build
OPENBRF_PLUGIN_SDK=/tmp/plugin-sdk.mjs pnpm check:package
```

CI does this against a pinned commit of openbrf/openbrf.

## Contributing

Contributions are welcome under the
[Open BRF contributor licence agreement](https://github.com/openbrf/openbrf/blob/main/CLA.md).
Commit messages and pull request titles follow
[Conventional Commits](https://www.conventionalcommits.org/).
