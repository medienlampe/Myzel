import type { FileUIPart } from "ai";

/**
 * Chat attachments are text only: the server inlines them for the model, so
 * they work with any model. Files are read here so a binary or oversized file
 * is turned away before anything is sent; the server checks again.
 */

export const DEFAULT_ATTACHMENT_LIMIT = 100_000;

export interface Attachment {
  part: FileUIPart;
  chars: number;
}

/** Browsers leave the type empty for many text formats (.md, .ts, .yaml, …). */
function mediaTypeOf(file: File): string {
  const type = file.type.toLowerCase();
  if (type.startsWith("text/") || /^application\/([\w.+-]*\+)?(json|xml|yaml)$/.test(type)) {
    return type;
  }
  return "text/plain";
}

/** UTF-8 → base64 in chunks: spreading a large array into fromCharCode overflows the stack. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Reads a file as an attachment, or throws a message fit for the user. */
export async function readAttachment(file: File, limit: number): Promise<Attachment> {
  // A UTF-8 character takes at most 4 bytes: anything larger cannot fit.
  if (file.size > limit * 4) throw new Error(`${file.name} is too large`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (err) {
    throw new Error(`${file.name} is not a text file`, { cause: err });
  }
  if (text.includes("\u0000")) throw new Error(`${file.name} is not a text file`);
  if (text.length > limit) throw new Error(`${file.name} is too large`);
  const mediaType = mediaTypeOf(file);
  return {
    part: {
      type: "file",
      mediaType,
      filename: file.name,
      url: `data:${mediaType};charset=utf-8;base64,${toBase64(text)}`,
    },
    chars: text.length,
  };
}

export function formatChars(chars: number): string {
  return chars < 1000 ? `${chars} chars` : `${(chars / 1000).toFixed(1)}k chars`;
}
