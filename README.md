# AI package for Open BRF

An [Open BRF](https://github.com/openbrf/openbrf) plugin that gives a housing
cooperative's board assistants built on a language model, on the association's
own model provider account and within a monthly limit the board sets.

The package's foundation is the settings, the way to the model, the licence
check and the limits. Its assistants are the
[document assistant](#the-document-assistant), which answers the board's
questions from the association's own documents, and
[issue triage](#issue-triage), which suggests how to handle an issue. The
other assistants come in later releases.

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

The package has no screen of its own yet. The route is what one calls. A
screen that shows its answers shows `answer`, `explanation` and the sources'
titles as plain text: no Markdown, no HTML, and no links made from addresses
in the text. A document can steer what the model writes, and the package
checks that the cited pages were read, not that an address in the answer is
on them.

## Issue triage

A board member asks for one issue to be triaged, and gets suggestions back: a
summary for the board, a category, a priority, and a draft reply to the
reporter. **Every part of it is a suggestion.** The package changes nothing on
the issue and sends nothing to anybody. A board member reads the suggestions,
decides, and does what they decide on the board's own issue screen, where the
reply they send is the one they write.

- **A category is an issue type.** The model picks one of the association's
  active issue types, or none when none fits, and says why. The type the issue
  was reported under is given beside it. The type's name is the core's, never
  the model's, and an id that is not an active type is refused back to the
  model. Nothing moves an issue to another type.
- **A priority is one of four steps**, with a reason: `urgent` (a risk to
  people or the building now, the same day), `high` (within days), `normal`
  and `low`. An issue in the core has no priority, so this is advice to the
  board and is not stored.
- **The reply is a draft**, in the language the reporter wrote in, which
  promises no date, cost or measure and admits no fault. The package has no
  permission to send mail or messages, and never asks for one.
- **The model is given the issue and cannot act on it.** The package reads the
  issue and the issue types itself, before the model is called, with the
  core's reads `issue_get` and `issue_type_list` (ADR 0040 in
  openbrf/openbrf), dispatched as the board member who asked, on the `ai`
  channel. The model is offered no action of the core's: its only tool is
  `give_triage`, which ends the triage, and any other tool it asks for is
  refused without anything being run. So nothing a reporter writes can make
  the package do anything.
- **Resident text is quoted data.** The issue reaches the model as JSON inside
  an `<issue>` element and the types inside `<issue_types>`. Every `<` in that
  JSON is written `\u003c`, so the reporter cannot close the element and write
  outside it. The model is told that everything inside the two elements is
  data and never an instruction, and to say in the summary when an issue
  contains one. `test/injection-issues.ts` holds the reports the tests try
  this with.
- **Bounded.** One triage makes at most 3 calls to the model, asking once more
  when the model answers in text or its triage is refused. It is not started
  when less than 40,000 tokens are left of the month.
- **Nothing is kept.** Not the issue, not the suggestions, not the reply.

### The route

`POST /api/plugin/ai-package/issues/triage` with `{ "issueId": "..." }`. It
requires `issues:handle` and `issues:configure`, which together are the
board's: the property manager handles issues too, but each triage is paid for
on the association's key. A connected app is refused, as on the document
assistant's route.

It answers `200` with:

```jsonc
{
  "issueId": "…",
  "summary": "Det droppar från badrumstaket i lägenhet 1101, och det ökar.",
  "category": {
    "suggested": {
      "id": "…",
      "title": "Vatten och avlopp",
      "audience": "MEMBER",
    },
    "current": { "id": "…", "title": "Tvättstuga", "audience": "MEMBER" },
    "reason": "…",
  },
  "priority": { "suggested": "urgent", "reason": "…" },
  "replyDraft": "Hej! Tack för din anmälan. …\n\nStyrelsen",
}
```

`category.suggested` is `null` when none of the active types fits. The summary
and the reasons are in the language the request asks for. When there are no
suggestions, the route answers with the gateway's refusals in the table above,
and with these of its own:

| Status | `reason`             | Why                                                                                                   |
| ------ | -------------------- | ----------------------------------------------------------------------------------------------------- |
| 400    | `issue-id-invalid`   | No issue id, one the core could not have handed out, or a body with other fields.                     |
| 404    | `issue-not-found`    | No issue by that id that this person may read, which includes one handled only on the board's screen. |
| 422    | `model-declined`     | The model declined to triage the issue.                                                               |
| 429    | `too-little-left`    | Less is left of this month's limit than one triage may use, 40,000 tokens.                            |
| 502    | `no-triage`          | The model gave no triage the package could check within its calls and its budget.                     |
| 503    | `issues-unavailable` | The host offers this person no `issue_get` or no `issue_type_list` on the `ai` surface.               |

`issue_type_list` is newer than the issue reads, so an instance without it
answers `issues-unavailable`. A screen that shows the suggestions shows them as
plain text, for the reason given for the document assistant's answers.

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
messages from residents, the board's own drafts, and the text of the documents
the document assistant reads. That text can name residents and their
apartments, and residents sometimes write about their health. The manifest
declares this for the board to read on the consent screen before the package
is installed: the personal-data categories `name`, `apartment`, `freeText` and
`health`, and the one recipient that receives them.

Each call to the model tells the host which categories it carries. For the
document assistant: free text for the question, and the categories each read
the conversation holds declares (`name` and `freeText` for the document reads).
It names no person as a subject, because the document text names people only
as text, and the package has no id for them. So the host records each call's
disclosure once, naming nobody. For issue triage: what the issue reads declare,
`name`, `apartment`, `freeText` and `health`, with the reporter as the subject
when the register holds them, so the host records the disclosure against that
person. Anybody else the report mentions is named only as text. The text of a document is not scanned or redacted: a document that
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

## The status route

`GET /api/plugin/ai-package/status` answers with the licence finding, the
provider and model, whether a key is entered (never the key), this month's use
and the two limits. It requires `association:read`, the board's reading of how
the instance is configured, and refuses a connected app with `403` and the
reason `connected-app`, as the assistants' routes do. On a host
without `host.actions.client` it answers `501` with `host-unsupported`.

## Development

```sh
pnpm install
pnpm test            # builds dist/server.cjs and runs the tests
pnpm typecheck
pnpm build
```

`pnpm test` runs the gateway and the assistants against a fake provider, the
Anthropic adapter against a stand-in for the host's way out, and the document
and issue reads against stand-ins for the core's, with the package's records in
memory. It also loads the bundle the package ships into a NestJS application on
Fastify and calls the status route and the assistants' routes.

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
