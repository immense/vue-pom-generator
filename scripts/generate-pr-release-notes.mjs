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

function ghApiJson(endpoint, { ghToken, fields } = {}) {
  const args = ["api", "-X", "GET", endpoint];
  for (const [key, value] of Object.entries(fields ?? {})) {
    args.push("-f", `${key}=${value}`);
  }
  const out = runGh(args, { env: { GH_TOKEN: ghToken } });
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`Failed to parse gh api JSON for ${endpoint}. Output was:\n${out}`);
  }
}

function ghApiAllPages(endpoint, { ghToken, perPage = 100, maxPages = 10, fields } = {}) {
  const results = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const pageFields = { per_page: perPage, page, ...(fields ?? {}) };
    const data = ghApiJson(endpoint, { ghToken, fields: pageFields });

    if (!Array.isArray(data)) {
      throw new TypeError(`Expected array response from ${endpoint} (page ${page}).`);
    }

    results.push(...data);
    if (data.length < perPage) {
      break;
    }
  }
  return results;
}

function firstLine(text) {
  const value = text ?? "";
  const newlineIndex = value.indexOf("\n");
  return newlineIndex === -1 ? value : value.slice(0, newlineIndex);
}

function summarizeFiles(files, { limit = 200 } = {}) {
  const items = files.slice(0, limit).map((f) => {
    const filename = f?.filename ?? "";
    const status = f?.status ?? "";
    const additions = typeof f?.additions === "number" ? f.additions : 0;
    const deletions = typeof f?.deletions === "number" ? f.deletions : 0;
    return `- ${filename} (${status}) +${additions} -${deletions}`;
  });

  if (files.length > limit) {
    items.push(`- …and ${files.length - limit} more files`);
  }

  return items.join("\n");
}

const repo = process.env.GITHUB_REPOSITORY || requireEnv("RELEASE_REPOSITORY");
const prNumber = Number(requireEnv("PR_NUMBER"));
if (!Number.isFinite(prNumber) || prNumber <= 0) {
  throw new Error(`Invalid PR_NUMBER: ${process.env.PR_NUMBER}`);
}

const ghToken = requireEnv("GH_TOKEN");
const copilotToken = requireEnv("COPILOT_GITHUB_TOKEN");

const outPath = process.env.PR_RELEASE_NOTES_PATH || "PR_RELEASE_NOTES.md";

const pr = ghApiJson(`repos/${repo}/pulls/${prNumber}`, { ghToken });
const prUrl = pr?.html_url ?? "";

const files = ghApiAllPages(`repos/${repo}/pulls/${prNumber}/files`, { ghToken, maxPages: 10 });
const commits = ghApiAllPages(`repos/${repo}/pulls/${prNumber}/commits`, { ghToken, maxPages: 10 });

const totalAdditions = files.reduce((sum, f) => sum + (typeof f?.additions === "number" ? f.additions : 0), 0);
const totalDeletions = files.reduce((sum, f) => sum + (typeof f?.deletions === "number" ? f.deletions : 0), 0);

const commitSubjects = commits
  .map((c) => firstLine(c?.commit?.message))
  .filter(Boolean)
  .slice(0, 200)
  .map((s) => `- ${s}`)
  .join("\n");

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
        `Generate suggested release notes for changes in PR #${prNumber}${prUrl ? ` (${prUrl})` : ""}.`,
        "",
        "Follow this structure:",
        "- ## Highlights (3-6 bullets)",
        "- ## Changes (bulleted; group by theme when possible)",
        "- ## Breaking Changes (only if any)",
        "- ## Pull Requests Included (bulleted, with links; include this PR)",
        "- ## Testing (brief; mention if none)",
        "",
        `Repository: ${repo}`,
        `PR title: ${pr?.title ?? ""}`,
        `PR author: @${pr?.user?.login ?? ""}`,
        `Base: ${pr?.base?.ref ?? ""} (${pr?.base?.sha ?? ""})`,
        `Head: ${pr?.head?.ref ?? ""} (${pr?.head?.sha ?? ""})`,
        "",
        "PR description:",
        (pr?.body ?? "").trim() || "<empty>",
        "",
        `Diffstat (from PR files): +${totalAdditions} -${totalDeletions}`,
        "",
        "Files:",
        summarizeFiles(files) || "<no files>",
        "",
        "Commits:",
        commitSubjects || "<no commits>",
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
