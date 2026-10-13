/**
 * Chat attachments arrive as AI SDK file parts carrying a data: URL. Only text
 * is accepted, and it is inlined as a text part before the conversation reaches
 * the model: that works with every model (a local one rarely takes file
 * inputs), and nothing but a data: URL ever reaches the provider — a remote URL
 * would make it fetch whatever the client named.
 */

export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 415,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

const TEXT_APPLICATION_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/sql",
  "application/x-ndjson",
]);

export function isTextMediaType(mediaType: string): boolean {
  const type = mediaType.split(";")[0].trim().toLowerCase();
  return (
    type === "text" ||
    type.startsWith("text/") ||
    TEXT_APPLICATION_TYPES.has(type) ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

const DATA_URL = /^data:([^,]*?)(;base64)?,(.*)$/s;

function decodeDataUrl(url: string): string {
  const match = DATA_URL.exec(url);
  if (!match) throw new AttachmentError("attachments must be sent inline as data: URLs", 400);
  try {
    return match[2]
      ? new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(match[3], "base64"))
      : decodeURIComponent(match[3]);
  } catch (err) {
    throw new AttachmentError("an attachment is not valid UTF-8 text", 415, { cause: err });
  }
}

/** The name only labels the block; keep it from closing the tag or adding lines. */
function attachmentName(filename: unknown): string {
  const name = typeof filename === "string" ? filename : "attachment";
  return name.replace(/[\r\n"<>]/g, "_").slice(0, 200) || "attachment";
}

interface Part {
  type: string;
  [key: string]: unknown;
}

/**
 * Replace every file part with a text part holding its content. Returns the
 * rewritten messages and the attachment characters in the newest user turn,
 * which the route caps on their own.
 */
export function inlineAttachments<M extends { role: string; parts: Part[] }>(
  messages: M[]
): { messages: M[]; newestTurnChars: number } {
  const newestUser = messages.map((m) => m.role).lastIndexOf("user");
  let newestTurnChars = 0;
  const rewritten = messages.map((message, index) => {
    if (!message.parts.some((p) => p.type === "file")) return message;
    const parts = message.parts.map((part): Part => {
      if (part.type !== "file") return part;
      const mediaType = typeof part.mediaType === "string" ? part.mediaType : "";
      if (!isTextMediaType(mediaType)) {
        throw new AttachmentError(
          `only text files can be attached (got ${mediaType.slice(0, 100) || "an unknown type"})`,
          415
        );
      }
      const text = decodeDataUrl(typeof part.url === "string" ? part.url : "");
      if (index === newestUser) newestTurnChars += text.length;
      const name = attachmentName(part.filename);
      return { type: "text", text: `<attachment name="${name}">\n${text}\n</attachment>` };
    });
    return { ...message, parts };
  });
  return { messages: rewritten, newestTurnChars };
}
