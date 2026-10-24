# AI package for Open BRF

An [Open BRF](https://github.com/openbrf/openbrf) plugin that gives a housing
cooperative's board assistants built on a language model, on the association's
own model provider account and within a monthly limit the board sets.

The package's foundation is the settings, the way to the model, the licence
check and the limits that every assistant shares. Its first assistants are the
[document assistant](#the-document-assistant), which answers the board's
questions from the association's own documents, and the
[site and news assistant](#the-site-and-news-assistant), which writes the
association's news and pages from a prompt: the board member describes a
change, the assistant drafts it, and nothing is written until the board member
has read it in full and confirmed it. The other assistants come in later
releases.

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

## The document assistant

A board member asks a question, and the assistant answers it from the
association's document archive, naming the documents and the pages the answer
rests on. When the documents do not settle the question, it says so, with the
documents it read, instead of answering.

- **It reads as the person who asked.** The model reads the archive through the
  core's two document reads, `document_list` and `document_get` (ADR 0041 in
  openbrf/openbrf). The package dispatches them through `host.actions.invoke`
  with the request it is serving, so the host records them on the `ai` channel
  (ADR 0038) and the archive's own rule decides what they return: what that
  person may read on the archive's screen, and never the board's shelf, which
  the reads do not offer. The model is offered those two reads, as the host
  lists them to that person, and no other action.
- **Every answer has a source that was read.** The model finishes with one of
  two tools of the package's own: `give_answer`, with the answer and its
  sources, or `report_no_answer`. A source must be a document that
  `document_get` returned to the model in an earlier turn, and its pages ones
  that came back with text. A read the model asks for in the same turn as its
  answer has not reached it yet, so the answer is checked without it, and the
  read's text goes back to the model with the refusal. A source that was not
  read is refused back to the model, which may read it or correct the answer.
  A model that never gives a source it read gives no answer at all. The board member sees each source's title,
  binder and pages as the archive names them, never as the model wrote them.
  What the package checks is that the cited pages were read. Whether they say
  what the answer says is for the board member to see on those pages.
- **Document text is data.** The model is told that what the reads return was
  written by people and is never an instruction, and the reads' own
  descriptions say the same. The only tools are reads and the two that end
  the question, so nothing a document says can make the assistant change
  anything.
- **Bounded per question.** A question has a budget of 250,000 tokens,
  counted as the monthly limit counts them. It is not asked when less than
  that is left of the month, and is refused with `too-little-left` before
  anything is read. Every call sends the conversation so far again, so each
  is about as large as the one before it, and larger by what was read in
  between. A call after which another as large would pass the budget is the
  question's last, and the model is told to finish in it; once the budget is
  used up, no call is made. A question can therefore pass its budget only
  when its calls grow from one to the next, and then by less than its last
  call.
- **And within the budget.** At most 10 calls to the model, the last of them
  told so, 6 tool calls answered in one turn, and 150,000 characters of
  document text read, about 40,000 tokens. A read that would pass that share
  is cut short where it does, and says where its text goes on; what is cut
  off is not sent and cannot be cited. A read the model asks for in its last
  call is not made. Each request asks the provider to cache the conversation
  so far, so a later call of the same question can read what an earlier one
  sent at the cache's lower rate; a conversation shorter than the provider's
  smallest cacheable length is not cached. Each call counts against the
  monthly limit and the per-minute limit like any other, and the monthly
  limit counts tokens read from the cache as it counts any other. Questions
  asked at once by several board members can each start with the budget
  left, so together they can pass the monthly limit by what they use; the
  per-minute limit bounds how fast.
- **Scanned documents are not read.** A PDF without a text layer is a set of
  pictures, and the core reads no pictures. The assistant says so when such a
  document is the one the question is about.
- **Nothing is kept.** Not the question, not what was read, not the answer:
  the package's records hold the usage counts only, and the log holds no text.

### The route

`POST /api/plugin/ai-package/documents/ask` with `{ "question": "..." }`, at
most 2,000 characters. It requires `documents:manage`, the board's, because
every question is paid for on the association's key. A connected app is
refused: it has a model of its own and reaches the same reads through the MCP
Connector. A host without `host.actions.client` cannot say whether a connected
app sent a request, so the route refuses every request there with `501` and
`host-unsupported`, before anything is read.

It answers `200` with one of:

```jsonc
{
  "outcome": "answered",
  "answer": "Styrelsen består av lägst tre och högst sju ledamöter (§ 14).",
  "sources": [
    {
      "id": "…",
      "title": "Stadgar 2024",
      "category": "Stadgar",
      "audience": "MEMBER",
      "pages": [2],
    },
  ],
}
```

```jsonc
{
  "outcome": "not-in-documents",
  "explanation": "…",
  "consulted": [
    { "id": "…", "title": "…", "category": "…", "audience": "MEMBER" },
  ],
}
```

When there is no answer it says why, with `reason` and a `message` in the
language the request asks for (Swedish unless English):

| Status | `reason`                  | Why                                                                                        |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------ |
| 400    | `question-invalid`        | No question, a question too long, or a body with other fields.                             |
| 403    | `connected-app`           | The request came from a connected app.                                                     |
| 403    | `entitlement-required`    | No active licence for the AI package.                                                      |
| 422    | `model-declined`          | The model declined the question.                                                           |
| 429    | `usage-limit-reached`     | This month's limit is used up.                                                             |
| 429    | `too-little-left`         | Less is left of this month's limit than one question may use, 250,000 tokens.              |
| 429    | `rate-limited`            | Too many calls this minute, here or at the provider; `retryAfterSeconds` when anyone said. |
| 501    | `host-unsupported`        | The instance is older than the package, or has no `host.actions.client`.                   |
| 502    | `provider-failed`         | The provider gave no answer.                                                               |
| 502    | `no-answer`               | The model gave no answer the assistant could check within its calls and its budget.        |
| 503    | `provider-not-configured` | No API key is entered.                                                                     |
| 503    | `documents-unavailable`   | The host offers this person no document reads on the `ai` surface.                         |

The document assistant has no screen of its own yet. The route is what one
calls. A screen that shows its answers shows `answer`, `explanation` and the
sources' titles as plain text: no Markdown, no HTML, and no links made from
addresses in the text. A document can steer what the model writes, and the package
checks that the cited pages were read, not that an address in the answer is
on them.

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
running, or, once the turn has finished or died and an hour has passed since
it started, told that the turn is over. A turn first sent more
than a week before, or dated more than a week ahead, is not run at all. So a
retried turn proposes nothing twice, however late it is sent again, and within
a turn a change the model asks for twice is proposed once.

The request running a turn says in the record that it is alive before each
call to the model and each change it proposes, and a turn counts as running
for as long as it is heard from, however long that is. One not heard from in
ten minutes died with its request: a later request finishes its record and is
answered with what it had proposed, and the request, should it be only slow,
finds the record finished and proposes nothing more.

The record holds each pending change's id, action, address and expiry and,
while the turn runs, when it was last heard from. It holds nothing anybody
wrote: not the request, not the answer, not what a change would write, and not
who asked. A turn still running keeps its record whatever its age. For a
turn that has finished or died, the pending changes become eligible for removal
an hour after it started, leaving only the time the turn started, and the
record becomes eligible for deletion after two weeks: by then the route
refuses every request that could carry its id. Both are done by a later
request, which sweeps a few records each time, not by a timer, so a record can
outlast these times; the answer "the turn is over" does not wait for the sweep.

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
messages from residents, the board's own drafts, the text of the documents the
document assistant reads, and the news and pages the site and news assistant
reads and drafts. That text can name residents and their apartments, and residents sometimes write about their health. The manifest
declares this for the board to read on the consent screen before the package
is installed: the personal-data categories `name`, `apartment`, `freeText` and
`health`, and the one recipient that receives them.

Each call to the model tells the host which categories it carries. The
document assistant's carries free text for the question, and the categories
each read the conversation holds declares (`name` and `freeText` for the
document reads); the site and news assistant's carries `name` and `freeText`.
No call names a person as a subject, because the text names people only as
text, and the package has no id for them. So the host records each call's disclosure once, naming
nobody. The text of a document is not scanned or redacted: a document that
names a person with protected personal data sends that name to the provider if
a board member asks about it, as the core's data protection page for the AI
package sets out.

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
the instance is configured, and refuses a connected app with `403` and the
reason `connected-app`, as the document assistant's route does. On a host
without `host.actions.client` it answers `501` with `host-unsupported`.

`POST /api/plugin/ai-package/assistants/site/turns` takes one turn of the site
and news assistant: `turnId`, a UUID the view mints, `sentAt`, the time the
view first sent the turn as `Date.toISOString()` writes it, and `messages`, the
conversation so far as alternating `{ role, text }` from the person and the
assistant, ending with the person. It answers with the outcome, the model's
answer and the pending changes the turn proposed. A turn arrives again under
the same `turnId` and `sentAt` when its answer was lost, and runs once: a
repeat is answered with the changes the turn proposed, `in-progress` while it
runs, or `expired` once those changes are no longer kept, an hour on. A turn
whose `sentAt` is more than a week from the server's time, before or after,
runs not at all and is answered `expired`: it was first sent too long ago, or
the clock of the device that sent it is off. It requires `site:manage`
and refuses a connected app, whose token would put the turn's calls on `mcp`
rather than `ai`. On a host without `host.actions.client` it answers with the
outcome `host-unsupported` and runs nothing.

## Development

```sh
pnpm install
pnpm test            # builds dist/server.cjs and runs the tests
pnpm typecheck
pnpm build
```

`pnpm test` runs the gateway and both assistants against a fake provider, the
Anthropic adapter against a stand-in for the host's way out, the document reads
against a stand-in for the core's, and the site assistant's actions against a
stand-in for `host.actions`, with the package's records in memory. It also
loads the bundle the package ships into a NestJS application on Fastify and
calls the status route and both assistants' routes, and renders the view in a
DOM.

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
`ActionRefusal` a call is refused with and the secret setting came later.
`src/host-contract.ts` declares them as the SDK does, and the package checks for each one at run time, because an older host does not
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
