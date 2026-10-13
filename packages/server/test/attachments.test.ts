import { describe, expect, it } from "vitest";
import { AttachmentError, inlineAttachments, isTextMediaType } from "../src/api/attachments.js";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const file = (url: string, mediaType = "text/markdown", filename?: string) => ({
  type: "file",
  mediaType,
  url,
  ...(filename === undefined ? {} : { filename }),
});

describe("isTextMediaType", () => {
  it("accepts text formats and refuses binary ones", () => {
    for (const t of ["text", "text/plain", "TEXT/CSV; charset=utf-8", "application/json"]) {
      expect(isTextMediaType(t)).toBe(true);
    }
    expect(isTextMediaType("application/vnd.api+json")).toBe(true);
    expect(isTextMediaType("image/svg+xml")).toBe(true);
    for (const t of ["image/png", "application/pdf", "application/octet-stream", ""]) {
      expect(isTextMediaType(t)).toBe(false);
    }
  });
});

describe("inlineAttachments", () => {
  it("turns file parts into text and counts only the newest user turn", () => {
    const messages = [
      {
        role: "user",
        parts: [file(`data:text/markdown;base64,${b64("old")}`, "text/markdown", "a.md")],
      },
      { role: "assistant", parts: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        parts: [
          { type: "text", text: "see" },
          file(`data:text/plain;charset=utf-8;base64,${b64("Grüße")}`, "text/plain", 'x"\n<y>.md'),
          file("data:text/plain,a%20b"),
        ],
      },
    ];
    const { messages: out, newestTurnChars } = inlineAttachments(messages);
    expect(newestTurnChars).toBe(8);
    expect(out[0].parts[0]).toEqual({
      type: "text",
      text: '<attachment name="a.md">\nold\n</attachment>',
    });
    expect(out[1]).toBe(messages[1]);
    expect(out[2].parts[0]).toEqual({ type: "text", text: "see" });
    expect(out[2].parts[1]).toEqual({
      type: "text",
      text: '<attachment name="x___y_.md">\nGrüße\n</attachment>',
    });
    expect(out[2].parts[2]).toEqual({
      type: "text",
      text: '<attachment name="attachment">\na b\n</attachment>',
    });
  });

  it("refuses binary types, remote URLs and invalid text", () => {
    const run = (part: object) => () =>
      inlineAttachments([{ role: "user", parts: [part as never] }]);
    expect(run(file("data:image/png;base64,AAAA", "image/png"))).toThrow(/only text files/);
    expect(run({ type: "file", url: "data:," })).toThrow(/unknown type/);
    expect(run(file("https://example.com/secret.md"))).toThrow(/data: URLs/);
    expect(run({ type: "file", mediaType: "text/plain" })).toThrow(/data: URLs/);
    expect(
      run(file(`data:text/plain;base64,${Buffer.from([0xff, 0xfe]).toString("base64")}`))
    ).toThrow(/not valid UTF-8/);
    expect(run(file("data:text/plain,%E0%A4%A"))).toThrow(AttachmentError);
  });
});
