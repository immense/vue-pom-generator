import { execSync } from "node:child_process";
import fs from "node:fs";

import { CopilotClient } from "@github/copilot-sdk";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function runGit(args) {
  return execSync(`git ${args}`, { stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
}

function getLatestReleaseTag() {
  const tagsRaw = runGit("tag --list 'v*' --sort=-v:refname");
  return tagsRaw.split(/\r?\n/).filter(Boolean)[0] ?? "";
}

function getCommitList(range) {
  const rangePart = range ? ` ${range}` : "";
  return runGit(`log --pretty=format:%s (%an) [%h]${rangePart}`);
}

function getDiffStat(range) {
  if (!range) {
    return runGit("show --stat");
  }
  return runGit(`diff --stat ${range}`);
}

const version = requireEnv("RELEASE_VERSION");
const outPath = process.env.RELEASE_NOTES_PATH || "RELEASE_NOTES.md";

const previousTag = process.env.RELEASE_PREVIOUS_TAG ?? getLatestReleaseTag();
const range = previousTag ? `${previousTag}..HEAD` : "";

const commits = getCommitList(range);
const stats = getDiffStat(range);

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
        "Include:",
        "- Highlights (3-6 bullets)",
        "- Full change list (bulleted)",
        "- If there are breaking changes, add a Breaking Changes section",
        "",
        "Commits:",
        commits || "<no commits>",
        "",
        "Diffstat:",
        stats || "<no stats>",
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

  fs.writeFileSync(outPath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  process.stdout.write(`Wrote ${outPath}\n`);
} finally {
  await session.destroy();
  await client.stop();
}
