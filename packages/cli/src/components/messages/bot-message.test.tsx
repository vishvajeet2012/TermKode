import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "../../providers/theme";
import { BotMessage } from "./bot-message";
import type { Message } from "../../hooks/use-chat";

// The bug these guard against is one types cannot catch: a reply drawn as plain
// text shows the user `**bold**` and `### Heading` verbatim. They assert on the
// frame the terminal actually paints, so the markers have to really be gone -
// which is also how the built-in <markdown> element was found to draw nothing
// at all without web-tree-sitter.

type Part = Message["parts"][number];

function textPart(text: string): Part {
  return { type: "text", text } as Part;
}

async function renderReply(text: string) {
  const { renderer, captureCharFrame, flush, waitForVisualIdle } = await testRender(
    <ThemeProvider>
      <BotMessage parts={[textPart(text)]} model="test/model" mode="BUILD" />
    </ThemeProvider>,
    { width: 80, height: 30 },
  );

  await flush();
  await waitForVisualIdle();
  const frame = captureCharFrame();
  renderer.destroy();
  return frame;
}

describe("BotMessage markdown rendering", () => {
  test("draws plain prose", async () => {
    const frame = await renderReply("I checked your RAM and ran a test.");
    expect(frame).toContain("I checked your RAM and ran a test.");
  });

  test("draws bold text without its markers", async () => {
    const frame = await renderReply("Your RAM is **16 GB usable** today.");

    expect(frame).toContain("16 GB usable");
    expect(frame).not.toContain("**");
  });

  test("draws a heading without its hashes", async () => {
    const frame = await renderReply("### Your installed RAM\n\nSome detail.");

    expect(frame).toContain("Your installed RAM");
    expect(frame).toContain("Some detail.");
    expect(frame).not.toContain("###");
  });

  test("draws a bullet list as bullets", async () => {
    const frame = await renderReply("- **Total:** 16 GB\n- **Speed:** 2400 MHz");

    expect(frame).toContain("•");
    expect(frame).toContain("Total:");
    expect(frame).toContain("2400 MHz");
    expect(frame).not.toContain("**");
  });

  test("draws inline code without its backticks", async () => {
    const frame = await renderReply("Run `bun test` to check.");

    expect(frame).toContain("bun test");
    expect(frame).not.toContain("`");
  });

  test("draws a fenced code block, markers and all content", async () => {
    const frame = await renderReply("Here:\n\n```sh\nbun run dev\n```\n");

    expect(frame).toContain("bun run dev");
    expect(frame).not.toContain("```");
  });

  test("draws a table as aligned columns", async () => {
    const frame = await renderReply(
      "| Tool | Mode |\n| --- | --- |\n| bash | BUILD |\n| grep | PLAN |",
    );

    expect(frame).toContain("Tool");
    expect(frame).toContain("BUILD");
    expect(frame).toContain("PLAN");
    expect(frame).not.toContain("| ---");
  });

  test("draws a link label and its target", async () => {
    const frame = await renderReply("See [the docs](https://example.com/docs) for more.");

    expect(frame).toContain("the docs");
    expect(frame).toContain("https://example.com/docs");
    expect(frame).not.toContain("](");
  });

  test("draws a partially received reply without leaking its markers", async () => {
    // Mid-stream the closing marker has not arrived yet; an unclosed one stays
    // literal, but everything already complete is styled.
    const frame = await renderReply("### Heading arrived\n\n**bold still arriv");

    expect(frame).toContain("Heading arrived");
    expect(frame).not.toContain("###");
  });

  test("draws the whole shape of a real reply", async () => {
    const frame = await renderReply(
      [
        "I checked your RAM.",
        "",
        "### Your installed RAM",
        "- **Total:** 16 GB usable",
        "- **Speed:** 2400 MHz",
        "",
        "That is a basic test.",
      ].join("\n"),
    );

    expect(frame).toContain("I checked your RAM.");
    expect(frame).toContain("Your installed RAM");
    expect(frame).toContain("16 GB usable");
    expect(frame).toContain("That is a basic test.");
    expect(frame).not.toContain("**");
    expect(frame).not.toContain("###");
  });
});
