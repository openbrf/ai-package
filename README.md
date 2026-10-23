# AI package for Open BRF

An [Open BRF](https://github.com/openbrf/openbrf) plugin that gives a housing
cooperative's board assistants built on a language model, on the association's
own model provider account and within a monthly limit the board sets.

Its first assistant writes the association's news and pages from a prompt:
the board member describes a change, the assistant drafts it, and nothing is
written until the board member has read it in full and confirmed it. Under
it are the settings, the way to the model, the licence check and the limits
that every assistant shares.

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

## The site and news assistant

A board member opens the package's view, **AI assistant** in the board's
section of the navigation (`/app/plugin/ai-package`), and describes what they
want written or changed in the news or on the website's pages. The model
reads what it needs and drafts the change with the news and page actions the
instance offers an AI package (ADR 0038 in openbrf/openbrf, "News and pages on
`ai`").

- **Nothing is written before the person confirms.** The assistant proposes
  every change through `host.actions.propose` and never through `invoke`.
  Each one becomes a pending change (ADR 0039 in openbrf/openbrf), and the
  view links to it on the platform's own pending changes screen, where the
  board member reads it field by field and confirms or rejects it. The view
  has no confirm button, and the package cannot confirm a change. The view
  also always links that screen itself, so a reload or a new conversation
  does not cut the way to changes still open. A pending change lapses after
  a week.
- **Mailings are a step of their own.** The assistant cannot mail the members.
  If asked to, it proposes a mailing request (`news_request_mailing`), which
  records the request once confirmed and sends nothing. A board member then
  decides the mailing on the news screen.
- **What the instance must offer.** The news and page actions on the `ai`
  surface, which openbrf/openbrf#528 adds. On an instance without them the
  host lists no tools to the assistant, which can then only answer in words.
- **What it may reach.** The news and the pages: reading them, writing them,
  publishing and unpublishing them, and who may read them. Not deleting
  anything, the front page, the order of the pages or the menu: the instance
  does not offer those to an AI package. The host lists the actions the
  person may use, so the model is told of nothing they could not do
  themselves, and the route requires `site:manage`, the board's own grant for
  the news and the pages.
- **No update over newer work.** A news update is proposed only with the
  revision the model read, so one confirmed after somebody else saved the
  item is refused rather than written over it. A page update needs the
  revision anyway.
- **Stored text is data.** The model is told that the text of news items and
  pages is written by people and never instructions, and the tools'
  descriptions say the same.
- **What the audit log shows.** The proposal is recorded on the `ai` channel,
  naming the package. The write, once confirmed, is the confirming person's
  in the web interface, and its entry names the pending change.

### One turn, run once

The view gives every turn an id of its own, and sends a turn whose answer
never arrived, or that is still running, again under the same id and with the
time it first sent it. The first request with an id claims it in the
package's records before the model is called, and a later one runs nothing: it
is answered with the changes the turn proposed, told that the turn is still
running, or, after an hour, told that the turn is over. A turn first sent more
than a week before, or dated more than a week ahead, is not run at all. So a
retried turn proposes nothing twice, however late it is sent again, and within
a turn a change the model asks for twice is proposed once.

The record holds each pending change's id, action, address and expiry, and
nothing anybody wrote: not the request, not the answer, not what a change
would write, and not who asked. After an hour the pending changes are removed
from it, leaving only the time the turn started, and after two weeks the
record is deleted: by then the route refuses every request that could carry
its id.

### What is sent to the model

The conversation as the view keeps it, and what the actions return: the
news and the pages, with an image's file id and alternative text but never
the image. Each call says it carries names and free text, and names no
person, because the package cannot tell whom a text is about (the plugin
contract, "A request that carries personal data"). The view keeps the
conversation; the package keeps none of it.

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

## The routes

`GET /api/plugin/ai-package/status` answers with the licence finding, the
provider and model, whether a key is entered (never the key), this month's use
and the two limits. It requires `association:read`, the board's reading of how
the instance is configured, and refuses a connected app.

`POST /api/plugin/ai-package/assistants/site/turns` takes one turn of the site
and news assistant: `turnId`, a UUID the view mints, `sentAt`, the time the
view first sent the turn as `Date.toISOString()` writes it, and `messages`, the
conversation so far as alternating `{ role, text }` from the person and the
assistant, ending with the person. It answers with the outcome, the model's
answer and the pending changes the turn proposed. A turn arrives again under
the same `turnId` and `sentAt` when its answer was lost, and runs once: a
repeat is answered with the changes the turn proposed, `in-progress` while it
runs, or `expired` once those changes are no longer kept, an hour on. A turn
whose `sentAt` is more than a week from the server's time runs not at all and
is answered `expired`. It requires `site:manage`
and refuses a connected app, whose token would put the turn's calls on `mcp`
rather than `ai`.

## Development

```sh
pnpm install
pnpm test            # builds dist/server.cjs and runs the tests
pnpm typecheck
pnpm build
```

`pnpm test` runs the gateway and the assistant against a fake provider and a
stand-in for `host.actions`, and the Anthropic adapter against a stand-in for
the host's way out, with the package's records in memory. It loads the bundle
the package ships into a NestJS application on Fastify and calls both routes,
and renders the view in a DOM.

`pnpm build` builds the view, a Module Federation remote at
`dist/remoteEntry.js`, and then the server entry point, one CommonJS bundle,
`dist/server.cjs`, whose only externals are `@nestjs/common` and Node's
built-ins. `pnpm check:package` runs
the SDK's `pluginPackageProblems` over the packed tarball, as the catalog does
before it lists a release. With the SDK 1.0.0 it refuses this manifest, so run
it as described below.

### Host members newer than the SDK release

The package builds against `@openbrf/plugin-sdk` 1.0.0. `host.recipients`,
`host.records`, `host.entitlements`, `host.actions.client`,
`host.actions.propose`, the schemas `host.actions.list` hands over, the
`ActionRefusal` a call is refused with and the secret setting came later. `src/host-contract.ts` declares them as the SDK does, and
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
