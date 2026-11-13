import { describe, expect, it } from "vitest";

import {
  authProviderIds,
  getAuthProviderLabel,
  isGitHubLogin,
  isGitHubRepository,
} from "../src/index.js";

describe("GitHub scope validation", () => {
  it.each([
    ["ordinary-user", true],
    ["Managed-User_Microsoft", true],
    [`${"a".repeat(29)}_microsoft`, true],
    [`${"a".repeat(30)}_microsoft`, false],
    ["-user", false],
    ["user-", false],
    ["user--name", false],
    ["_enterprise", false],
    ["user_", false],
    ["user/name", false],
    ["user?name", false],
    [null, false],
  ])("validates account and author login %s", (value, valid) => {
    expect(isGitHubLogin(value)).toBe(valid);
  });

  it.each([
    ["Managed-User_Microsoft/Project.name_1", true],
    [`owner/${"a".repeat(100)}`, true],
    [`owner/${"a".repeat(101)}`, false],
    ["owner", false],
    ["owner/", false],
    ["owner/repo/extra", false],
    ["owner/repo?query", false],
    ["owner/repo#fragment", false],
    ["owner/repo name", false],
    ["bad--owner/repo", false],
  ])("validates repository scope %s", (value, valid) => {
    expect(isGitHubRepository(value)).toBe(valid);
  });
});

describe("getAuthProviderLabel", () => {
  it("labels every supported provider", () => {
    expect(authProviderIds.map(getAuthProviderLabel)).toEqual([
      "GitHub",
      "Google",
      "Microsoft",
    ]);
  });
});
