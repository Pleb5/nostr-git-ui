import { describe, expect, it } from "vitest";

import {
  getHighlightJs,
  getHighlightLanguageForPath,
  highlightCodeSnippet,
  loadCodeMirrorLanguageExtensions,
} from "../src/lib/utils/codeHighlight";

describe("code highlighting helpers", () => {
  it("resolves common language aliases from file paths", () => {
    expect(getHighlightLanguageForPath("app/main.kt")).toBe("kotlin");
    expect(getHighlightLanguageForPath("app/main.dart")).toBe("dart");
    expect(getHighlightLanguageForPath("infra/Dockerfile")).toBe("dockerfile");
    expect(getHighlightLanguageForPath("Cargo.toml")).toBe("toml");
    expect(getHighlightLanguageForPath("scripts/profile.ps1")).toBe("powershell");
    expect(getHighlightLanguageForPath("queries/schema.graphql")).toBe("graphql");
    expect(getHighlightLanguageForPath("gradle.properties")).toBe("ini");
  });

  it("registers shared highlight.js languages once", () => {
    const highlighter = getHighlightJs();

    expect(highlighter.getLanguage("kotlin")).toBeTruthy();
    expect(highlighter.getLanguage("dart")).toBeTruthy();
    expect(highlighter.getLanguage("dockerfile")).toBeTruthy();
    expect(highlighter.getLanguage("toml")).toBeTruthy();
    expect(highlighter.getLanguage("powershell")).toBeTruthy();
    expect(highlighter.getLanguage("graphql")).toBeTruthy();
  });

  it("highlights newly supported snippet languages", () => {
    const highlighted = highlightCodeSnippet('fun main() = println("hi")', "kotlin");

    expect(highlighted).toContain("hljs");
  });

  it("loads CodeMirror support for newly added file-view languages", async () => {
    await expect(loadCodeMirrorLanguageExtensions("src/main.kt", null)).resolves.toHaveLength(1);
    await expect(loadCodeMirrorLanguageExtensions("src/main.dart", null)).resolves.toHaveLength(1);
    await expect(loadCodeMirrorLanguageExtensions("Dockerfile", null)).resolves.toHaveLength(1);
    await expect(loadCodeMirrorLanguageExtensions("Cargo.toml", null)).resolves.toHaveLength(1);
    await expect(loadCodeMirrorLanguageExtensions("scripts/setup.ps1", null)).resolves.toHaveLength(
      1
    );
    await expect(loadCodeMirrorLanguageExtensions("src/index.php", null)).resolves.toHaveLength(1);
  });
});
