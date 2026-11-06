import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { collectActivity } from "../src/github.ts";

const snapshot = await collectActivity({
  accounts: (process.env.GITHUB_ACCOUNTS ?? "shazhou-ww")
    .split(",")
    .map((account) => account.trim()),
  token: process.env.GH_TOKEN ?? "",
  authorLogin: process.env.GITHUB_AUTHOR_LOGIN ?? "shazhou-ww",
  authorEmails: (process.env.GITHUB_AUTHOR_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean),
});
const directory = resolve(".data");
await mkdir(directory, { recursive: true });
await writeFile(
  resolve(directory, "snapshot.json"),
  `${JSON.stringify(snapshot)}\n`,
);
console.info(
  `Collected ${snapshot.repositories.length} public repositories, ${snapshot.totals.commits} commits by ${snapshot.authorFilter?.login}; confirmed author email matching: ${snapshot.authorFilter?.emailMatching}. Saved .data/snapshot.json.`,
);
