import { describe, expect, it } from "vitest";

import {
  ACCESS_TOKEN_SETTINGS_PATH,
  getAccessTokenManagementMessage,
  getAccessTokenSettingsLink,
  isAccessTokenManagementIssue,
  isWorkflowScopeIssue,
} from "./tokenManagement";

describe("token management helpers", () => {
  it("resolves provider settings links", () => {
    expect(ACCESS_TOKEN_SETTINGS_PATH).toBe("/settings/profile");
    expect(getAccessTokenSettingsLink("github.com")?.url).toBe(
      "https://github.com/settings/tokens"
    );
    expect(getAccessTokenSettingsLink("gitlab")?.url).toBe(
      "https://gitlab.com/-/user_settings/personal_access_tokens"
    );
  });

  it("detects workflow scope failures as token issues", () => {
    const error = "GitHub requires the workflow token scope to push files under .github/workflows.";

    expect(isWorkflowScopeIssue(error)).toBe(true);
    expect(isAccessTokenManagementIssue(error)).toBe(true);
    expect(getAccessTokenManagementMessage(error)).toContain("workflow token scope");
  });

  it("detects missing or invalid token failures", () => {
    expect(isAccessTokenManagementIssue("Missing token for target host")).toBe(true);
    expect(
      isAccessTokenManagementIssue("No github authentication token found for push operation")
    ).toBe(true);
    expect(isAccessTokenManagementIssue("Token validation failed: Invalid token")).toBe(true);
    expect(isAccessTokenManagementIssue("Remote appears to have new commits")).toBe(false);
  });
});
