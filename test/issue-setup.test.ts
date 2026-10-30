import { describe, expect, it } from "vitest";
import { hostOf, repoOf, setupMessage, setupQuestions } from "../src/renderer/src/issueSetup";

describe("issue setup questions", () => {
  it("reads the host and repo from https and ssh remotes", () => {
    expect(hostOf("https://github.com/cubisai/harness.git")).toBe("github");
    expect(hostOf("git@gitlab.example.com:group/sub/name.git")).toBe("gitlab");
    expect(hostOf("https://gitea.local:3000/o/r")).toBe("gitea");
    expect(hostOf("https://example.com/o/r")).toBeNull();
    expect(hostOf(null)).toBeNull();
    expect(repoOf("https://github.com/cubisai/harness.git")).toBe("cubisai/harness");
    expect(repoOf("git@gitlab.example.com:group/sub/name.git")).toBe("group/sub/name");
  });

  it("recommends the detected host first, and Local first without a remote", () => {
    const [tracker] = setupQuestions("https://github.com/cubisai/harness.git");
    expect(tracker!.options.map((o) => o.label)).toEqual(["GitHub (Recommended)", "GitLab", "Gitea", "Local"]);
    expect(tracker!.options[0]!.description).toBe("cubisai/harness, through the gh CLI");
    expect(setupQuestions(null)[0]!.options.map((o) => o.label)).toEqual(["Local (Recommended)", "GitHub", "GitLab", "Gitea"]);
    expect(setupQuestions(null).map((q) => q.id)).toEqual(["tracker", "labels", "templates"]);
  });

  it("turns the answers into the skill's message, without templates for Local", () => {
    const remote = "https://github.com/cubisai/harness.git";
    expect(setupMessage({ answers: { tracker: ["GitHub (Recommended)"], labels: ["Defaults (Recommended)"], templates: ["No templates"] } }, remote)).toBe(
      "Tracker: GitHub\nLabels: Defaults\nTemplates: No templates\nThe origin remote is https://github.com/cubisai/harness.git.",
    );
    expect(setupMessage({ answers: { tracker: ["Local"], labels: ["My own names"], templates: ["Add them (Recommended)"] } }, null)).toBe("Tracker: Local\nLabels: My own names");
    expect(setupMessage("dismiss", remote)).toBeNull();
  });
});
