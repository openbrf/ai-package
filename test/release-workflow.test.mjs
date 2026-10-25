import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parse } from "yaml";

/**
 * Holds where the release workflow's secrets may be read. Any step of a job
 * can read every secret the job references, and the source's install, tests,
 * evaluation and build run third-party code, so each secret is kept to the
 * jobs that need it and out of the jobs that run that code where it can be.
 * An artifact of a public repository can be downloaded by anyone signed in,
 * so nothing unsealed is uploaded before the evaluation, the release gate,
 * has passed. Only the package's own files of the private source reach the
 * jobs that run its dependencies, and the tarball attested is the one the
 * build job packed.
 */
const workflows = new URL("../.github/workflows/", import.meta.url);
const read = async (name) =>
  parse(await readFile(new URL(name, workflows), "utf8"));
const release = await read("release.yml");
const jobs = Object.entries(release.jobs);

/** Each string anywhere in a value, with the path to it. */
function* strings(value, path = []) {
  if (typeof value === "string") {
    yield [value, path];
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      yield* strings(child, [...path, key]);
    }
  }
}

/**
 * The names of the secrets a value refers to, with the path to each. The word
 * counts anywhere in a string, not only where this test can tell an
 * expression apart: `${{ format('{0}', secrets.NAME) }}` has a `}` inside.
 * GitHub reads context and secret names in any case, so `Secrets.name` is
 * `secrets.NAME`.
 */
function* secretReferences(value) {
  for (const [text, path] of strings(value)) {
    for (const word of text.matchAll(/\bsecrets\b(\.\w+)?/gi)) {
      // `secrets[...]` or `toJSON(secrets)` would hand on secrets this test
      // cannot name.
      assert.ok(
        word[1],
        `${path.join(".")} refers to secrets without naming one`,
      );
      yield [word[1].slice(1).toUpperCase(), path];
    }
  }
}

const secretsOf = (job) =>
  new Set([...secretReferences(job)].map(([name]) => name));
const jobsReferring = (name) =>
  jobs.filter(([, job]) => secretsOf(job).has(name));
// Not a file name such as `pnpm-lock.yaml`.
const runsNode = (step) =>
  /^(pnpm|actions)\/(action-setup|setup-node)@/.test(step.uses ?? "") ||
  /\b(pnpm|npm|npx|node|corepack|yarn)\b(?!-)/.test(step.run ?? "");

describe("the secret-reach check", () => {
  it("reads a secret's name in any case", () => {
    assert.deepEqual(
      [
        ...secretReferences({
          env: {
            A: "${{ Secrets.SOURCE_DEPLOY_KEY }}",
            B: "${{ format('{0}', SECRETS.anthropic_api_key) }}",
          },
        }),
      ],
      [
        ["SOURCE_DEPLOY_KEY", ["env", "A"]],
        ["ANTHROPIC_API_KEY", ["env", "B"]],
      ],
    );
  });

  it("refuses secrets it cannot name, in any case", () => {
    for (const text of [
      "${{ toJSON(SECRETS) }}",
      "${{ toJSON(Secrets) }}",
      "${{ secrets['SOURCE_DEPLOY_KEY'] }}",
    ]) {
      assert.throws(
        () => [...secretReferences({ env: { A: text } })],
        /refers to secrets without naming one/,
        text,
      );
    }
  });
});

describe("the release workflow", () => {
  it("starts on a version tag only", () => {
    assert.deepEqual(release.on, { push: { tags: ["v*"] } });
  });

  it("refers to secrets only in a step", () => {
    assert.deepEqual([...secretReferences({ ...release, jobs: {} })], []);
    for (const [name, job] of jobs) {
      const { steps, ...rest } = job;
      assert.deepEqual(
        [...secretReferences(rest)],
        [],
        `job ${name} refers to a secret outside its steps`,
      );
      assert.ok(
        !JSON.stringify(job).includes("secrets: inherit"),
        `job ${name} inherits secrets`,
      );
    }
  });

  it("holds every secret in the release environment", () => {
    for (const [name, job] of jobs) {
      if (secretsOf(job).size > 0) {
        assert.equal(
          job.environment,
          "release",
          `job ${name} refers to a secret outside the release environment`,
        );
      }
    }
  });

  it("holds each secret in the jobs listed for it and no others", () => {
    const holders = {};
    for (const [name, job] of jobs) {
      for (const secret of secretsOf(job)) {
        (holders[secret] ??= []).push(name);
      }
    }
    for (const names of Object.values(holders)) {
      names.sort();
    }
    assert.deepEqual(holders, {
      ANTHROPIC_API_KEY: ["eval"],
      SOURCE_ARCHIVE_KEY: ["build", "eval", "fetch"],
      SOURCE_DEPLOY_KEY: ["fetch"],
    });
  });

  it("makes nothing unsealed downloadable before the evaluation passes", () => {
    const [[evaluation, evaluator]] = jobsReferring("ANTHROPIC_API_KEY");
    const gate = evaluator.steps.find((step) =>
      secretsOf(step).has("ANTHROPIC_API_KEY"),
    );
    // A failed evaluation has to fail its job, and the job the run.
    for (const [where, value] of [
      [`job ${evaluation}`, evaluator],
      [`the evaluation step of job ${evaluation}`, gate],
    ]) {
      assert.equal(value.if, undefined, `${where} may be skipped`);
      assert.equal(
        value["continue-on-error"],
        undefined,
        `${where} may fail without failing the run`,
      );
    }
    for (const [name, job] of jobs) {
      const uploadsUnsealed = job.steps.some(
        (step) =>
          /^actions\/upload-artifact@/.test(step.uses ?? "") &&
          !/\.enc$/.test(step.with?.path ?? ""),
      );
      const publishes = ["id-token", "attestations", "contents"].some(
        (permission) => job.permissions?.[permission] === "write",
      );
      if (uploadsUnsealed || publishes) {
        assert.ok(
          [job.needs].flat().includes(evaluation),
          `job ${name} does not wait for the evaluation`,
        );
        // `always()`, `failure()` or `!cancelled()` would run it after a
        // failed evaluation.
        assert.equal(
          job.if,
          undefined,
          `job ${name} has a condition of its own`,
        );
      }
    }
    assert.deepEqual([release.jobs.build.needs].flat().sort(), [
      "eval",
      "fetch",
    ]);
    assert.deepEqual([release.jobs.publish.needs].flat().sort(), [
      "build",
      "eval",
      "fetch",
    ]);
  });

  it("fetches the source in a job that runs no Node and seals what it hands on", () => {
    const holders = jobsReferring("SOURCE_DEPLOY_KEY");
    assert.equal(holders.length, 1, "exactly one job holds the deploy key");
    const [[name, job]] = holders;
    for (const step of job.steps) {
      // Only the actions listed here, so a new one is a decision to make.
      if (step.uses !== undefined) {
        assert.match(
          step.uses,
          /^actions\/(checkout|upload-artifact)@/,
          `job ${name} holds the deploy key and runs ${step.uses}`,
        );
      }
      assert.ok(
        !runsNode(step),
        `job ${name} holds the deploy key and runs Node in ${step.name ?? step.uses}`,
      );
      if (/^actions\/upload-artifact@/.test(step.uses ?? "")) {
        assert.match(
          step.with.path,
          /\.enc$/,
          `job ${name} uploads something it has not sealed`,
        );
      }
    }
    const steps = job.steps.filter((step) =>
      secretsOf(step).has("SOURCE_DEPLOY_KEY"),
    );
    assert.equal(steps.length, 1);
    assert.match(steps[0].uses, /^actions\/checkout@/);
    assert.equal(steps[0].with["persist-credentials"], false);
  });

  it("hands on only the package's files and installs its dependencies alone", () => {
    const [[name, job]] = jobsReferring("SOURCE_DEPLOY_KEY");
    const seal = job.steps.find((step) =>
      /\bopenssl enc\b/.test(step.run ?? ""),
    );
    assert.ok(seal, `job ${name} seals nothing`);
    const script = seal.run.replace(/\\\n/g, " ");
    const [, paths] =
      script.match(/\bsparse-checkout set --no-cone ([^\n]*)/) ?? [];
    assert.ok(paths, `job ${name} seals the whole commit`);
    // The source's other modules stay out of the jobs that run the
    // dependencies of this one.
    assert.deepEqual(paths.trim().split(/\s+/).sort(), [
      "/.github/workflows/ci.yml",
      "/.gitignore",
      "/.nvmrc",
      "/modules/ai-package/",
      "/package.json",
      "/pnpm-lock.yaml",
      "/pnpm-workspace.yaml",
    ]);
    const order = [
      /\bsparse-checkout set\b/,
      /\bfetch\b[^\n]*--filter=blob:none\b/,
      /\bcheckout\b[^\n]*FETCH_HEAD\b/,
      /\bcat-file --batch-all-objects\b/,
      /\bopenssl enc\b/,
    ].map((pattern) => script.search(pattern));
    assert.ok(
      order.every(
        (at, index) => at >= 0 && (index === 0 || at > order[index - 1]),
      ),
      `job ${name} does not fetch the package's blobs alone and check that before sealing`,
    );
    for (const [other, { steps }] of jobs) {
      for (const step of steps) {
        for (const [, args] of (step.run ?? "").matchAll(
          /\bpnpm (?:install|i|add)\b([^\n;&|>]*)/g,
        )) {
          assert.match(
            args,
            /(^|\s)--filter \.\/modules\/ai-package\.\.\.(\s|$)/,
            `job ${other} installs more than the package's dependencies`,
          );
        }
      }
    }
  });

  it("hands the model provider key to the evaluation's step alone", () => {
    const holders = jobsReferring("ANTHROPIC_API_KEY");
    assert.equal(
      holders.length,
      1,
      "exactly one job holds the model provider key",
    );
    const [[name, job]] = holders;
    assert.ok(
      !secretsOf(job).has("SOURCE_DEPLOY_KEY"),
      `job ${name} holds both keys`,
    );
    const references = [...secretReferences(job.steps)].filter(
      ([secret]) => secret === "ANTHROPIC_API_KEY",
    );
    assert.equal(references.length, 1);
    const [[, [index, ...path]]] = references;
    assert.deepEqual(
      path,
      ["env", "ANTHROPIC_API_KEY"],
      `job ${name} hands the key on other than in a step's env`,
    );
    assert.match(job.steps[Number(index)].run, /\bpnpm eval\b/);
    for (const step of job.steps) {
      for (const [, args] of (step.run ?? "").matchAll(
        /\bpnpm (?:install|i|add)\b([^\n;&|>]*)/g,
      )) {
        assert.match(
          args,
          /--ignore-scripts\b/,
          `job ${name} runs install scripts next to the model provider key`,
        );
      }
    }
  });

  it("attests only the tarball the build job packed", () => {
    const { build, publish } = release.jobs;
    assert.equal(
      build.outputs.digest,
      "${{ steps.pack.outputs.digest }}",
      "job build hands on no digest of its tarball",
    );
    const pack = build.steps.find((step) => step.id === "pack");
    assert.match(pack.run, /\bdigest=\$\(sha256sum\b/);
    const attest = publish.steps.findIndex((step) =>
      /^actions\/attest-build-provenance@/.test(step.uses ?? ""),
    );
    const check = publish.steps.findIndex(
      (step) =>
        step.env?.DIGEST === "${{ needs.build.outputs.digest }}" &&
        /\bsha256sum\b/.test(step.run ?? ""),
    );
    assert.ok(check >= 0, "job publish does not check the tarball's digest");
    assert.ok(check < attest, "job publish attests before checking");
    // The file checked is the one attested and the one released.
    const create = publish.steps.find((step) =>
      /\bgh release create\b/.test(step.run ?? ""),
    );
    assert.equal(
      publish.steps[attest].with["subject-path"],
      publish.steps[check].env.FILE,
      "job publish attests another file than it checks",
    );
    assert.equal(
      create.env.FILE,
      publish.steps[check].env.FILE,
      "job publish releases another file than it checks",
    );
    assert.match(create.run, /^\s*gh release create "\$TAG" "\$FILE"/m);
    // A step that fails fails the job before it attests.
    for (const key of ["if", "continue-on-error"]) {
      assert.equal(publish.steps[check][key], undefined);
    }
  });

  it("refuses a tarball whose digest differs, before attesting", async () => {
    const check = release.jobs.publish.steps.find(
      (step) => step.name === "Check the tarball",
    );
    assert.ok(check, "job publish has no step named Check the tarball");
    const dir = await mkdtemp(join(tmpdir(), "release-check-"));
    try {
      const file = join(dir, "package.tgz");
      const bytes = "the bytes the build job packed";
      await writeFile(file, bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const otherDigest = createHash("sha256").update("other").digest("hex");
      // The step's own script, with the values the workflow binds to it.
      const run = (env) =>
        spawnSync("bash", ["-e", "-c", check.run], {
          encoding: "utf8",
          env: { PATH: process.env.PATH, FILE: file, DIGEST: digest, ...env },
        });

      assert.equal(run({}).status, 0, "a matching digest is refused");
      for (const [why, env] of [
        ["a differing digest", { DIGEST: otherDigest }],
        ["an empty digest", { DIGEST: "" }],
        ["a missing file", { FILE: join(dir, "missing.tgz") }],
      ]) {
        const result = run(env);
        assert.equal(result.status, 1, `${why} is accepted`);
        assert.match(result.stdout, /^::error::/m, `${why} gives no error`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fetches from the repository source.json names, and only that one", async () => {
    const pin = JSON.parse(
      await readFile(new URL("../source.json", import.meta.url), "utf8"),
    );
    const [readPin] = release.jobs.fetch.steps.filter(
      (step) => step.id === "pin",
    );
    assert.equal(readPin.env.SOURCE_REPOSITORY, pin.repository);
    assert.match(readPin.run, /\.repository\b[^\n]*\$SOURCE_REPOSITORY/);
    const sources = release.jobs.fetch.steps.filter(
      (step) => step.with?.repository !== undefined,
    );
    assert.deepEqual(
      sources.map((step) => `https://github.com/${step.with.repository}`),
      [pin.repository],
    );
  });

  it("attests and publishes in a job that holds no secret", () => {
    for (const [name, job] of jobs) {
      const publishes = ["id-token", "attestations", "contents"].some(
        (permission) => job.permissions?.[permission] === "write",
      );
      if (publishes) {
        assert.deepEqual(
          [...secretsOf(job)],
          [],
          `job ${name} may publish and holds a secret`,
        );
        assert.equal(
          job.environment,
          undefined,
          `job ${name} may publish and runs in an environment`,
        );
      }
    }
  });

  it("deletes the run's artifacts in a job that runs nothing of the source", () => {
    const deleters = jobs.filter(
      ([, job]) => job.permissions?.actions === "write",
    );
    assert.equal(deleters.length, 1);
    const [[name, job]] = deleters;
    assert.equal(
      job.if,
      "always()",
      `job ${name} skips its cleanup when the run fails`,
    );
    // Run before a job ends, it would miss what that job uploads.
    assert.deepEqual(
      [job.needs].flat().sort(),
      jobs
        .map(([other]) => other)
        .filter((other) => other !== name)
        .sort(),
      `job ${name} does not wait for every other job`,
    );
    assert.deepEqual([...secretsOf(job)], []);
    assert.ok(
      job.steps.every((step) => step.uses === undefined && !runsNode(step)),
    );
  });

  it("sets every job's permissions", () => {
    assert.deepEqual(release.permissions, { contents: "read" });
    for (const [name, job] of jobs) {
      assert.ok(
        job.permissions,
        `job ${name} takes the workflow's permissions`,
      );
    }
  });
});

describe("every workflow", async () => {
  const names = (await readdir(workflows)).filter((name) =>
    /\.ya?ml$/.test(name),
  );

  for (const name of names) {
    const workflow = await read(name);

    it(`${name} pins each action by its full commit id`, () => {
      for (const [text, path] of strings(workflow)) {
        if (path.at(-1) === "uses") {
          assert.match(
            text,
            /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/,
            `${name}: ${path.join(".")}`,
          );
        }
      }
    });

    if (name !== "release.yml") {
      it(`${name} refers to no secret`, () => {
        assert.deepEqual([...secretReferences(workflow)], []);
      });
    }
  }
});
