import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

import { CopilotClient } from "@github/copilot-sdk";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function runGit(args) {
  return execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
}

function runGh(args, { env } = {}) {
  return execFileSync("gh", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GH_PAGER: "cat",
      ...env,
    },
  })
    .toString("utf8")
    .trim();
}

function runGhJson(args, { env } = {}) {
  const out = runGh([...args, "--jq", "."], { env });
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`Failed to parse gh output as JSON. Output was:\n${out}`);
  }
}

function getLatestReleaseTag() {
  return runGit([
    "for-each-ref",
    "--sort=-v:refname",
    "--count=1",
    "--format=%(refname:short)",
    "refs/tags/v*",
  ]);
}

function getCommitList(range) {
  const args = ["log", "--pretty=format:%s (%an) [%h]"];
  if (range) {
    args.push(range);
  }
  return runGit(args);
}

function getDiffStat(range) {
  if (!range) {
    return runGit(["show", "--stat"]);
  }
  return runGit(["diff", "--stat", range]);
}

function getNameStatus(range) {
  if (!range) {
    return runGit(["show", "--name-status"]);
  }
  return runGit(["diff", "--name-status", range]);
}

function getCommitDateISO(ref) {
  return runGit(["show", "-s", "--format=%cI", ref]);
}

function fetchMergedPullRequests({ repo, sinceISO, untilISO }) {
  const ghToken = requireEnv("GH_TOKEN");

  const qParts = [`repo:${repo}`, "is:pr", "is:merged"];
  if (sinceISO) qParts.push(`merged:>=${sinceISO}`);
  if (untilISO) qParts.push(`merged:<=${untilISO}`);
  const q = qParts.join(" ");

  const prsByNumber = new Map();
  for (let page = 1; page <= 10; page += 1) {
    const resp = runGhJson(
      [
        "api",
        "-X",
        "GET",
        "search/issues",
        "-f",
        `q=${q}`,
        "-f",
        "per_page=100",
        "-f",
        `page=${page}`,
      ],
      { env: { GH_TOKEN: ghToken } },
    );

    const items = Array.isArray(resp?.items) ? resp.items : [];
    for (const item of items) {
      const number = item?.number;
      if (typeof number !== "number") continue;
      prsByNumber.set(number, {
        number,
        title: item?.title ?? "",
        url: item?.html_url ?? "",
        author: item?.user?.login ?? "",
        labels: Array.isArray(item?.labels) ? item.labels.map((l) => l?.name).filter(Boolean) : [],
      });
    }

    if (items.length < 100) {
      break;
    }
  }

  return [...prsByNumber.values()].sort((a, b) => a.number - b.number);
}

function getOutputTarget(envVarName) {
  const raw = process.env[envVarName];

  // Explicitly requested stdout.
  if (raw === "-") return { type: "stdout" };

  // If unspecified, default to stdout (callers that want a file must set the env var).
  if (!raw) return { type: "stdout" };

  return { type: "file", path: raw };
}

const version = requireEnv("RELEASE_VERSION");
const outputTarget = getOutputTarget("RELEASE_NOTES_PATH");

const repo = process.env.RELEASE_REPOSITORY || process.env.GITHUB_REPOSITORY;
if (!repo) {
  throw new Error("Missing required env var: GITHUB_REPOSITORY (or RELEASE_REPOSITORY)");
}

const previousTag = process.env.RELEASE_PREVIOUS_TAG ?? getLatestReleaseTag();
const range = previousTag ? `${previousTag}..HEAD` : "";

const commits = getCommitList(range);
const stats = getDiffStat(range);
const nameStatus = getNameStatus(range);

const sinceISO = previousTag ? getCommitDateISO(previousTag) : "";
const untilISO = getCommitDateISO("HEAD");

const mergedPullRequests = fetchMergedPullRequests({
  repo,
  sinceISO: sinceISO || undefined,
  untilISO: untilISO || undefined,
});

const copilotToken = requireEnv("COPILOT_GITHUB_TOKEN");

const client = new CopilotClient({
  githubToken: copilotToken,
  useLoggedInUser: false,
  cliPath: "./node_modules/.bin/copilot",
});

const session = await client.createSession({
  model: process.env.COPILOT_MODEL || "gpt-5",
  systemMessage: {
    content:
      "You write concise, high-signal GitHub release notes in Markdown. Use headings and bullets. Do not invent changes; only summarize what is provided.",
  },
});

try {
  const response = await session.sendAndWait(
    {
      prompt: [
        `Generate release notes for version v${version}.`,
        "",
        previousTag
          ? `Compare range: ${previousTag}..HEAD (exclude the release bump commit if it appears).`
          : "This is the initial release; summarize the project based on commit history.",
        "",
        "Follow this structure (similar to githubnext agentic workflow writeups):",
        "- ## Highlights (3-6 bullets)",
        "- ## Changes (bulleted; group by theme when possible)",
        "- ## Breaking Changes (only if any)",
        "- ## Pull Requests Included (bulleted, with links)",
        "- ## Testing (brief; mention if none)",
        "",
        `Repository: ${repo}`,
        previousTag ? `Window: merged PRs between ${sinceISO} and ${untilISO}` : `Window: recent context up to ${untilISO}`,
        "",
        "Commits:",
        commits || "<no commits>",
        "",
        "Diffstat:",
        stats || "<no stats>",
        "",
        "Files (name-status):",
        nameStatus || "<no files>",
        "",
        "Merged pull requests in this release window:",
        mergedPullRequests.length
          ? mergedPullRequests
              .map((pr) => `- #${pr.number} ${pr.title}${pr.url ? ` (${pr.url})` : ""}${pr.author ? ` (by @${pr.author})` : ""}`)
              .join("\n")
          : "<none found>",
        "",
        "Output only Markdown.",
      ].join("\n"),
    },
    180_000,
  );

  const content = response?.data?.content?.trim();
  if (!content) {
    throw new Error("Copilot SDK returned an empty response");
  }

  const markdown = content.endsWith("\n") ? content : `${content}\n`;

  if (outputTarget.type === "file") {
    fs.writeFileSync(outputTarget.path, markdown, "utf8");
    process.stderr.write(`Wrote ${outputTarget.path}\n`);
  } else {
    process.stdout.write(markdown);
  }
} finally {
  await session.destroy();
  await client.stop();
}
