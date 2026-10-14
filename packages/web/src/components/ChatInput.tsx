import { useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { EditorContent, Extension, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";
import type { FileUIPart } from "ai";
import type { AppConfig } from "../api";
import { composerMarkdown } from "../composer-markdown";
import {
  DEFAULT_ATTACHMENT_LIMIT,
  formatChars,
  readAttachment,
  type Attachment,
} from "../attachments";

/**
 * The chat composer. Markdown is formatted while it is typed (`**bold**`,
 * `- ` lists, ``` fences, …) and sent as markdown, so the agent receives what
 * the user wrote. The field grows up to five lines, then scrolls (the cap is
 * CSS: `5lh` plus the padding). Enter sends, Shift+Enter starts a new line —
 * or list item, or line in a code block. Text files attach by picker, drop or
 * paste. While a run is going, Send turns into Stop.
 */
export function ChatInput({
  busy,
  config,
  model,
  onModelChange,
  onSend,
  onStop,
}: {
  busy: boolean;
  config: AppConfig | null;
  model: string;
  onModelChange: (model: string) => void;
  onSend: (text: string, files: FileUIPart[]) => void;
  onStop: () => void;
}) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Characters attached or being read. A ref, not derived from state: two
  // overlapping drops or pastes must both count against the limit.
  const attachedChars = useRef(0);
  // Files still being read; sending meanwhile would leave them for the next message.
  const [reading, setReading] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const limit = config?.attachmentLimit ?? DEFAULT_ATTACHMENT_LIMIT;

  // The editor is created once; its key and paste handlers reach the current
  // render's functions through this ref.
  const latest = useRef({ submit: () => {}, addFiles: (_files: File[]) => {} });
  const editor = useEditor({
    // TipTap would inject a <style> element; its base rules live in index.css.
    injectCSS: false,
    extensions: [
      // Markdown has no underline, so Mod-U must not produce one; and a message
      // needs no empty paragraph kept after every list or code block.
      StarterKit.configure({ link: { openOnClick: false }, underline: false, trailingNode: false }),
      Placeholder.configure({ placeholder: "Ask or teach the knowledge base…" }),
      Extension.create({
        name: "chatKeys",
        priority: 1000,
        addKeyboardShortcuts() {
          return {
            Enter: () => {
              latest.current.submit();
              return true;
            },
            // What Enter does in a regular editor.
            "Shift-Enter": ({ editor }) =>
              editor.commands.first(({ commands }) => [
                () => commands.newlineInCode(),
                () => commands.splitListItem("listItem"),
                () => commands.createParagraphNear(),
                () => commands.liftEmptyBlock(),
                () => commands.splitBlock(),
              ]),
          };
        },
      }),
    ],
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Message the agent",
        class:
          "composer max-h-[calc(5lh+1.5rem)] overflow-y-auto px-4 py-3 text-sm leading-6 text-fg outline-hidden",
      },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.length === 0) return false;
        latest.current.addFiles(files);
        return true;
      },
      // Dropped files are the composer's (onDrop below); keep them out of the text.
      handleDrop: (_view, event) => (event.dataTransfer?.files.length ?? 0) > 0,
    },
  });
  const empty = useEditorState({
    editor,
    selector: ({ editor }) => !editor || editor.getText().trim() === "",
  });
  const canSend = !busy && reading === 0 && (!empty || attachments.length > 0);

  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    const added: Attachment[] = [];
    const problems: string[] = [];
    setReading((n) => n + 1);
    for (const file of files) {
      try {
        const attachment = await readAttachment(file, limit);
        if (attachedChars.current + attachment.chars > limit) {
          problems.push(`${file.name} would exceed ${formatChars(limit)} of attachments`);
          continue;
        }
        attachedChars.current += attachment.chars;
        added.push(attachment);
      } catch (err) {
        problems.push((err as Error).message);
      }
    }
    setReading((n) => n - 1);
    setAttachments((current) => [...current, ...added]);
    setNotice(problems.length ? `${problems.join("; ")} — only text files can be attached.` : null);
  }

  function submit() {
    if (!editor || !canSend) return;
    onSend(
      empty ? "" : composerMarkdown(editor.getJSON()),
      attachments.map((a) => a.part)
    );
    editor.commands.clearContent(true);
    setAttachments([]);
    attachedChars.current = 0;
    setNotice(null);
  }

  useLayoutEffect(() => {
    latest.current = { submit, addFiles: (files) => void addFiles(files) };
  });

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="p-3"
    >
      <div
        data-dropzone
        onDragOver={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          // Keep the workspace's panel drop handling out of it.
          e.preventDefault();
          e.stopPropagation();
          setDragging(false);
          void addFiles([...e.dataTransfer.files]);
        }}
        data-dragging={dragging || undefined}
        className={`rounded-xl border shadow-sm shadow-backdrop transition-colors ${
          dragging
            ? "border-blue bg-blue/10"
            : "border-line-strong/70 bg-raised/50 focus-within:border-blue/70"
        }`}
      >
        {attachments.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 px-3 pt-3" aria-label="Attachments">
            {attachments.map((a, i) => (
              <li
                key={`${a.part.filename}-${i}`}
                className="flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface py-1 pr-1 pl-2 text-xs"
              >
                <FileIcon />
                <span className="truncate text-strong">{a.part.filename}</span>
                <span className="shrink-0 text-muted">{formatChars(a.chars)}</span>
                <button
                  type="button"
                  onClick={() => {
                    attachedChars.current -= a.chars;
                    setAttachments((current) => current.filter((_, j) => j !== i));
                  }}
                  aria-label={`Remove ${a.part.filename}`}
                  className="icon-btn h-5 min-w-5 px-1"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <EditorContent editor={editor} />

        <div className="flex items-center gap-2 px-2 pb-2">
          <button
            type="button"
            onClick={() => picker.current?.click()}
            aria-label="Attach files"
            title="Attach text files (or drop / paste them here)"
            className="icon-btn h-8 min-w-8"
          >
            <PaperclipIcon />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])]);
              e.target.value = ""; // picking the same file again must fire again
            }}
          />

          {config && (
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
              {config.modelConfigured === false ? (
                <span
                  title="The server has no LLM configured. Set the LLM_* variables to ask questions."
                  className="truncate px-1.5 text-muted"
                >
                  no model
                </span>
              ) : config.modelOverride ? (
                <input
                  value={model}
                  onChange={(e) => onModelChange(e.target.value)}
                  placeholder={config.model || "auto"}
                  aria-label="Model override"
                  className="w-36 rounded-lg border border-transparent bg-transparent px-1.5 py-1 text-fg outline-hidden placeholder:text-faint hover:border-line focus:border-blue"
                />
              ) : (
                <span
                  title="The server decides the model. Set ALLOWED_MODELS to pick one here."
                  className="truncate px-1.5 text-muted"
                >
                  {config.model || "auto"}
                </span>
              )}
              {config.fallbackConfigured && (
                <span
                  title="Fallback model configured"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-green"
                />
              )}
            </div>
          )}

          {busy ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              title="Stop the agent"
              className="btn ml-auto h-8 w-8 shrink-0 bg-fg text-surface hover:bg-strong"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send"
              title="Send (Enter) · new line: Shift+Enter"
              className="btn ml-auto h-8 w-8 shrink-0 bg-blue text-on-accent hover:bg-blue/85 disabled:bg-raised disabled:text-faint disabled:opacity-100"
            >
              <ArrowUpIcon />
            </button>
          )}
        </div>
      </div>
      {notice && (
        <p role="status" className="mt-1.5 px-1 text-xs text-yellow">
          {notice}
        </p>
      )}
    </form>
  );
}

function PaperclipIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

export function FileIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5 shrink-0 text-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}
