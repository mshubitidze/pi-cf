import { test } from "bun:test";
import type { HtmlBuilder } from "foldkit/html";
import { expect, given, role, scene, selector, text } from "foldkit/scene";
import { renderMessageMarkdown } from "./markdown.ts";

const program = {
  update: (model: string, _message: never) => ({ model }),
  view: (model: string, h: HtmlBuilder<never>) => renderMessageMarkdown(model, h),
};

test("assistant Markdown renders semantic common formatting, references and task lists", () => {
  scene(
    program,
    given(
      [
        "# Answer",
        "",
        "**Strong**, *emphasis*, ~~obsolete~~ and `inline()`.",
        "",
        "> A quotation.",
        "",
        "3. Third",
        "4. Fourth",
        "",
        "- [x] Finished",
        "- [ ] Remaining",
        "",
        "Read the [reference][docs].",
        "",
        '[docs]: https://example.com/docs "Documentation"',
        "",
        "---",
      ].join("\n"),
    ),
    expect(role("heading", { name: "Answer", level: 2 })).toBeVisible(),
    expect(selector("strong")).toHaveText("Strong"),
    expect(selector("em")).toHaveText("emphasis"),
    expect(selector("del")).toHaveText("obsolete"),
    expect(selector("code")).toHaveText("inline()"),
    expect(selector("blockquote")).toHaveText("A quotation."),
    expect(selector("ol")).toHaveAttr("start", "3"),
    expect(role("img", { name: "Completed task" })).toBeVisible(),
    expect(role("img", { name: "Incomplete task" })).toBeVisible(),
    expect(role("link", { name: "reference" })).toHaveAttr("href", "https://example.com/docs"),
    expect(role("link", { name: "reference" })).toHaveAttr("title", "Documentation"),
    expect(role("link", { name: "reference" })).toHaveAttr("target", "_blank"),
    expect(selector("hr")).toExist(),
  );
});

test("raw HTML and code fences remain literal text without DOM injection", () => {
  const rawHtml = '<img src="https://tracker.example/pixel" onerror="alert(1)">';
  const code = '<script>alert("unsafe")</script>';
  scene(
    program,
    given(["**Safe formatting**", "", rawHtml, "", "```html", code, "```"].join("\n")),
    expect(selector("strong")).toHaveText("Safe formatting"),
    expect(text(rawHtml)).toExist(),
    expect(selector("pre code")).toHaveText(code),
    expect(selector("pre")).toHaveAttr("class", "max-w-full overflow-x-auto whitespace-pre"),
    expect(selector("img")).not.toExist(),
    expect(selector("script")).not.toExist(),
    expect(selector("[onerror]")).not.toExist(),
    expect(selector("[innerHTML]")).not.toExist(),
  );
});

test.each([
  "javascript:alert%281%29",
  "JaVaScRiPt:alert%281%29",
  "java&#x09;script:alert%281%29",
  "data:text/html,unsafe",
  "vbscript:unsafe",
  "file:///etc/passwd",
])("unsafe link URL %s renders its label without a link", (url) => {
  scene(
    program,
    given(`Before **safe** [Unsafe](${url}) after.`),
    expect(selector("strong")).toHaveText("safe"),
    expect(text("Unsafe")).toExist(),
    expect(role("link")).not.toExist(),
  );
});

test("remote images become explicit links without automatically loading resources", () => {
  scene(
    program,
    given("![Diagram](https://tracker.example/image.svg) ![Unsafe](data:image/svg+xml,unsafe)"),
    expect(role("link", { name: "Image: Diagram" })).toHaveAttr(
      "href",
      "https://tracker.example/image.svg",
    ),
    expect(role("link", { name: "Image: Diagram" })).toHaveAttr("target", "_blank"),
    expect(text("Image: Unsafe")).toExist(),
    expect(selector("img")).not.toExist(),
    expect(selector("[src]")).not.toExist(),
  );
});

test("wide tables keep semantic header cells inside a horizontal scroll container", () => {
  scene(
    program,
    given("| Left | Right |\n| :--- | ---: |\n| content | 123 |"),
    expect(selector(".markdown-table-scroll")).toHaveAttr(
      "class",
      "markdown-table-scroll max-w-full overflow-x-auto",
    ),
    expect(role("table")).toExist(),
    expect(role("columnheader", { name: "Left" })).toHaveAttr("scope", "col"),
    expect(role("cell", { name: "123" })).toExist(),
  );
});

test("first duplicate reference definition wins and safe HTTPS links stay usable", () => {
  scene(
    program,
    given("[Docs][a]\n\n[a]: https://example.com/first\n[a]: javascript:unsafe"),
    expect(role("link", { name: "Docs" })).toHaveAttr("href", "https://example.com/first"),
    expect(role("link", { name: "Docs" })).toHaveAttr("rel", "noopener noreferrer"),
  );
});

test.each([
  "https://example.com/docs",
  "http://example.com/docs",
  "//example.com/docs",
  "/docs",
  "./docs",
])("web link %s opens separately so the conversation draft survives", (url) => {
  scene(
    program,
    given(`[Docs](${url})`),
    expect(role("link", { name: "Docs" })).toHaveAttr("href", url),
    expect(role("link", { name: "Docs" })).toHaveAttr("target", "_blank"),
    expect(role("link", { name: "Docs" })).toHaveAttr("rel", "noopener noreferrer"),
  );
});

test.each(["#section", "mailto:hello@example.com", "tel:+15555555555"])(
  "fragment or operating-system link %s keeps its normal navigation context",
  (url) => {
    scene(
      program,
      given(`[Destination](${url})`),
      expect(role("link", { name: "Destination" })).toHaveAttr("href", url),
      expect(role("link", { name: "Destination" })).not.toHaveAttr("target"),
    );
  },
);
