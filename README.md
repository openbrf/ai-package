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
  `gh attestation verify <file>.tgz --repo openbrf/ai-package --source-ref refs/tags/v<version>`.
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
   the evaluation has passed.

The workflow refuses a tag that is not on `main`, whose `source.json` is not
`main`'s, or that does not match the version, and a pin that is not on the
main branch of apteoab/openbrf-modules. It fetches the pinned commit in a job
that runs none of the source's code, then runs the package's prompt-injection
evaluation in a job of its own. Only once that has passed does it run the
package's typecheck and tests in another job and pack it with the pin copied
in unchanged, so no tarball is made of a commit that failed the evaluation.
Then it attests the tarball and publishes the release. Its job summary gives
the sha512 and size for the catalog entry. Every release pays for one run of
the evaluation, on the model provider key below.

The run logs of this repository are public, so the output of the source's
dependency install, typecheck, tests, evaluation and build stays out of them.
A failed release says which step failed; running that step in a checkout of
the pinned commit shows why. The source passes from one job to the next only
encrypted, and the run deletes its artifacts, the tarball among them, when it
ends.

The workflow relies on these repository settings:

- releases are immutable;
- a tag ruleset lets only the maintainers create a `v*` tag, and nobody move or
  delete one;
- a branch ruleset on `main` requires a pull request approved by someone other
  than its author, and refuses force pushes and deletion;
- the `release` environment allows only `v*` tags, and a maintainer approves
  each run's jobs in it. It holds three secrets:
  - `SOURCE_DEPLOY_KEY`, a read-only deploy key on apteoab/openbrf-modules.
    The key reads every module in that repository, not only this package;
  - `SOURCE_ARCHIVE_KEY`, a random key that encrypts the source the run hands
    from one job to the next;
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
checks which jobs of the release workflow can read each secret.
