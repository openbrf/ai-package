# AI package for Open BRF: releases

The AI package is an [Open BRF](https://github.com/openbrf/openbrf) plugin that
gives a housing cooperative's board assistants built on a language model, on
the association's own model provider account and within a monthly limit the
board sets.

It is a paid module from Apteo AB. Its source is not in this repository. This
is a **release-only repository**, as Open BRF
[ADR 0044](https://github.com/openbrf/openbrf/blob/main/docs/adr/0044-a-listing-released-from-a-repository-without-its-source.md)
describes: it holds the release workflow, and each release is built from the
commit of the private source that `source.json`, at this repository's root,
pins.

## Installing

An instance installs the package from the
[Open BRF catalog](https://github.com/openbrf/catalog) once it is listed
there. Each version's tarball is an asset of this repository's
[releases](https://github.com/openbrf/ai-package/releases), and the board
enters the instance's licence on the instance's licence screen. No version has
been released yet.

## What a release proves

- **The tarball** is attested by this repository's
  [release workflow](.github/workflows/release.yml), in a run on the release's
  tag. Check it with
  `gh attestation verify <file>.tgz --repo openbrf/ai-package --source-ref refs/tags/v<version>`,
  then check that the commit it was attested from is on `main`. A tag of a
  commit off `main` can carry a workflow of its own that attests and
  publishes a tarball without the pin checks or the evaluation (see
  "Releasing"), so the attestation alone does not prove that the workflow on
  `main` made the tarball:

  ```sh
  commit=$(gh attestation verify <file>.tgz --repo openbrf/ai-package \
    --source-ref refs/tags/v<version> --format json \
    --jq '.[].verificationResult.signature.certificate.sourceRepositoryDigest')
  gh api "repos/openbrf/ai-package/compare/main...$commit" --jq .status
  ```

  The second command has to print `identical` or `behind`. The catalog's
  check of an attestation does not include this yet, so the reviewer of the
  catalog pull request that lists a version runs it.

- **The source** is named by the `source.json` packed in the tarball, a copy of
  this repository's `source.json` at the tagged commit. It is Apteo's
  statement of the commit the tarball was built from, kept in this
  repository's public history. The workflow builds only a commit on the main
  branch of apteoab/openbrf-modules. Whoever can read the source can check out
  that commit and build it with the same steps.
- **The prompt-injection evaluation passed** on that commit. Residents write
  text the assistants read, and such text may try to make the model act. The
  package's evaluation runs a corpus of such text against every model the
  board may choose, and passes on what the model does, not on what it says.
  The workflow runs it on the commit it builds, and a case that fails stops
  the release before anything is attested or published.

## Releasing

1. Open a pull request that moves `source.json` to the commit of
   apteoab/openbrf-modules to release:

   ```json
   {
     "repository": "https://github.com/apteoab/openbrf-modules",
     "commit": "<full commit id>"
   }
   ```

2. Merge it, then push the tag `v<version>` from `main` while `source.json`
   there still pins that commit. The version is the one the pinned commit's
   package states.
3. Approve the run in the `release` environment three times: before it
   fetches the source, before it evaluates it, and before it builds it once
   the evaluation has passed. Before each approval, check that the run's
   commit, shown on the run's page, is on `main`:

   ```sh
   gh api repos/openbrf/ai-package/compare/main...<commit> --jq .status
   ```

   It prints `identical` for the head of `main` and `behind` for an earlier
   commit of `main`; approve nothing else. For a `behind` commit, approve only
   if `main` has changed neither the release workflow nor `source.json` since,
   that is, if
   `gh api repos/openbrf/ai-package/compare/<commit>...main --jq '.files[].filename'`
   lists neither `.github/workflows/release.yml` nor `source.json`.

4. Once the run has ended, however it ended, replace `SOURCE_ARCHIVE_KEY`:

   ```sh
   openssl rand -base64 48 | gh secret set SOURCE_ARCHIVE_KEY --env release --repo openbrf/ai-package
   ```

GitHub runs the release workflow as it is at the tagged commit, so the
workflow's own refusals below hold only for a commit of `main`: a tag of any
other commit can carry a workflow without them. The approvals in step 3 gate
the `release` environment's secrets and nothing else. Their check keeps such
a run away from the secrets, and so from the private source and the model
provider key, but a workflow that uses no environment asks nobody for
approval: it can attest a tarball of its own and publish it. The tag ruleset
limits who can push such a tag, and the check under "What a release proves"
is what tells such a release apart.

The workflow refuses a tag that is not on `main`, whose `source.json` is not
`main`'s, or that does not match the version, and a pin that names a
repository other than apteoab/openbrf-modules, the only one it fetches from,
or a commit that is not on that repository's main branch. It fetches the
pinned commit in a job that runs none of the source's code, then runs the
package's prompt-injection evaluation in a job of its own. Only once that has
passed does it run the package's typecheck and tests in another job and pack
it with the pin copied in unchanged, so no tarball is made of a commit that
failed the evaluation. Then it attests the tarball and publishes the release.
Its job summary gives the sha512 and size for the catalog entry. Every release
pays for one run of the evaluation, on the model provider key below.

The run logs of this repository are public, so the output of the source's
dependency install, typecheck, tests, evaluation and build stays out of them.
A failed release says which step failed; running that step in a checkout of
the pinned commit shows why. Of the pinned commit, only the workspace's root
files, its CI workflow and the package's own directory pass from the fetch job
to the jobs that install the package's dependencies, so no other module's
source reaches them. That source passes from one job to the next only
encrypted, the run attests only the tarball its build job packed, and it
deletes its artifacts, the tarball among them, when it ends.

The workflow relies on these repository settings:

- releases are immutable;
- a tag ruleset lets only the maintainers create a `v*` tag, and nobody move or
  delete one;
- a branch ruleset on `main` requires a pull request approved by someone other
  than its author and the `Test the release workflow` check, from the GitHub
  Actions app so that no other check or status of that name stands in for it,
  and refuses force pushes and deletion;
- the `release` environment allows only `v*` tags, and a maintainer approves
  each run's jobs in it. It holds three secrets:
  - `SOURCE_DEPLOY_KEY`, a read-only deploy key on apteoab/openbrf-modules.
    The key reads every module in that repository, not only this package;
  - `SOURCE_ARCHIVE_KEY`, a key of at least 256 random bits, such as the 384
    bits `openssl rand -base64 48` gives, that encrypts the source the run
    hands from one job to the next. It is replaced after every run (step 4
    above), so a key read in one run opens no later run's source;
  - `ANTHROPIC_API_KEY`, a key of its own for the evaluation, in an Anthropic
    workspace of its own with a spend limit;
- the repository and its organisation hold no secret of these names outside
  that environment, and the repository has no other environment. Branches from
  before the source moved have an evaluation workflow of their own that reads
  `ANTHROPIC_API_KEY` from an `injection-eval` environment; that environment
  does not exist and is not to be created.

## Licence

The AI package is proprietary software of Apteo AB.

Its first versions were developed in this repository under the
[AGPL-3.0](https://github.com/openbrf/ai-package/blob/1359fa9/LICENSE). The
history published here stays public under that licence: the main branch up to
and including commit
[`1359fa9`](https://github.com/openbrf/ai-package/tree/1359fa9), and the
branches of the pull requests opened here. Later development is in the private
source and is not covered by it.

## Contributing

Commit messages and pull request titles follow
[Conventional Commits](https://www.conventionalcommits.org/). `pnpm test`
checks which jobs of the release workflow can read each secret, and what
passes from one job to the next.
