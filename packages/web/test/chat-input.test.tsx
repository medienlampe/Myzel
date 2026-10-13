import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatInput } from "../src/components/ChatInput";
import { createChat } from "../src/components/ChatPanel";
import { TestChatPanel } from "./support/chat-panel";
import { formatChars, readAttachment } from "../src/attachments";
import type { AppConfig } from "../src/api";
import { installFakeApi, uiStream } from "./support/fake-api";
import { typeMessage } from "./support/composer";

const CONFIG: AppConfig = { model: "fake-model", format: "openai", fallbackConfigured: false };

function setup(config: AppConfig | null = CONFIG, busy = false) {
  const onSend = vi.fn();
  const onStop = vi.fn();
  render(
    <ChatInput
      busy={busy}
      config={config}
      model=""
      onModelChange={() => {}}
      onSend={onSend}
      onStop={onStop}
    />
  );
  const field = screen.getByRole("textbox", { name: "Message the agent" });
  return { onSend, onStop, field, zone: field.closest<HTMLElement>("[data-dropzone]")! };
}

const textFile = (name: string, text: string, type = "") => new File([text], name, { type });

function pick(...files: File[]) {
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(picker, { target: { files } });
}

const decode = (url: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0)));

describe("ChatInput", () => {
  it("sends on Enter and starts a new line on Shift+Enter", async () => {
    const { onSend, field } = setup();
    const user = await typeMessage("line one{Shift>}{Enter}{/Shift}line two");
    expect(onSend).not.toHaveBeenCalled();
    expect(field.querySelectorAll("p")).toHaveLength(2);

    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("line one\n\nline two", []);
    expect(field).toHaveTextContent("");
  });

  it("formats markdown while typing and sends it as markdown", async () => {
    const { onSend, field } = setup();
    const user = await typeMessage("- deploy on **fridays**");
    expect(field.querySelector("ul strong")).toHaveTextContent("fridays");
    // Shift+Enter in a list adds an item, as Enter would in a plain editor.
    await user.keyboard("{Shift>}{Enter}{/Shift}use `make` & a_b < c{Enter}");
    expect(onSend).toHaveBeenCalledWith("- deploy on **fridays**\n- use `make` & a_b < c", []);
  });

  it("does not send an empty message", async () => {
    const { onSend } = setup();
    const user = await typeMessage("   ");
    await user.keyboard("{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("offers Stop instead of Send while a run is going, and does not send", async () => {
    const { onSend, onStop } = setup(CONFIG, true);
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    const user = await typeMessage("next question{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("attaches text files, lets them be removed, and sends them without text", async () => {
    const { onSend } = setup();
    pick(textFile("notes.md", "# Grüße"), textFile("drop.txt", "x", "text/plain"));
    expect(await screen.findByText("notes.md")).toBeInTheDocument();
    expect(screen.getByText("drop.txt")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove drop.txt" }));
    expect(screen.queryByText("drop.txt")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const [text, files] = onSend.mock.calls[0];
    expect(text).toBe("");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ type: "file", mediaType: "text/plain", filename: "notes.md" });
    expect(decode(files[0].url)).toBe("# Grüße");
    expect(screen.queryByRole("list", { name: "Attachments" })).not.toBeInTheDocument();
  });

  it("turns away binary and oversized files with a notice", async () => {
    setup({ ...CONFIG, attachmentLimit: 10 });
    pick(
      new File([new Uint8Array([0x89, 0x50, 0xff, 0xfe])], "photo.png", { type: "image/png" }),
      textFile("nul.txt", "a\u0000b"),
      textFile("long.txt", "x".repeat(11)),
      textFile("ok.txt", "x".repeat(6)),
      textFile("over.txt", "x".repeat(6))
    );
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("photo.png is not a text file");
    expect(notice).toHaveTextContent("nul.txt is not a text file");
    expect(notice).toHaveTextContent("long.txt is too large");
    expect(notice).toHaveTextContent("over.txt would exceed 10 chars of attachments");
    expect(screen.getByText("ok.txt")).toBeInTheDocument();
  });

  it("accepts dropped and pasted files", async () => {
    const { field, zone } = setup(null);
    const dropped = { types: ["Files"], files: [textFile("dropped.md", "d")], dropEffect: "" };
    fireEvent.dragOver(zone, { dataTransfer: dropped });
    expect(zone).toHaveAttribute("data-dragging");
    fireEvent.drop(zone, { dataTransfer: dropped });
    expect(await screen.findByText("dropped.md")).toBeInTheDocument();
    expect(zone).not.toHaveAttribute("data-dragging");

    fireEvent.paste(field, {
      clipboardData: { files: [textFile("pasted.md", "p")], types: ["Files"], getData: () => "" },
    });
    expect(await screen.findByText("pasted.md")).toBeInTheDocument();
    // A plain-text paste stays the editor's business.
    fireEvent.paste(field, {
      clipboardData: {
        files: [],
        types: ["text/plain"],
        getData: (type: string) => (type === "text/plain" ? "plain words" : ""),
      },
    });
    expect(field).toHaveTextContent("plain words");
    // A file dropped onto the text lands as an attachment once, not in the text.
    fireEvent.drop(field, {
      dataTransfer: { types: ["Files"], files: [textFile("onto.md", "o")], getData: () => "" },
    });
    expect(await screen.findAllByText("onto.md")).toHaveLength(1);
    expect(field).not.toHaveTextContent("onto");
    // Other drags (panels) are not taken over.
    fireEvent.dragOver(zone, { dataTransfer: { types: ["application/x-panel"], files: [] } });
    expect(zone).not.toHaveAttribute("data-dragging");
  });

  it("clears the drag highlight when the drag leaves", () => {
    const { zone } = setup();
    fireEvent.dragOver(zone, { dataTransfer: { types: ["Files"], files: [] } });
    fireEvent.dragLeave(zone, { relatedTarget: document.body });
    expect(zone).not.toHaveAttribute("data-dragging");
  });
});

describe("attachments", () => {
  it("keeps a text media type, and refuses files that cannot fit before reading them", async () => {
    const json = await readAttachment(textFile("a.json", "{}", "application/json"), 100);
    expect(json.part.mediaType).toBe("application/json");
    await expect(readAttachment(textFile("big.txt", "x".repeat(50)), 10)).rejects.toThrow(
      "big.txt is too large"
    );
    expect(formatChars(999)).toBe("999 chars");
    expect(formatChars(12_345)).toBe("12.3k chars");
  });
});

describe("ChatPanel with attachments", () => {
  it("shows a sent attachment as a chip in the conversation", async () => {
    const fake = installFakeApi({
      "/api/chat": () =>
        uiStream([
          { type: "start" },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Read it." },
          { type: "text-end", id: "t" },
          { type: "finish" },
        ]),
    });
    render(<TestChatPanel chat={createChat(() => {})} config={CONFIG} onOpenConcept={() => {}} />);
    pick(textFile("runbook.md", "steps"));
    await screen.findByText("runbook.md");
    await typeMessage("remember this");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Read it.")).toBeInTheDocument();
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    const sent = JSON.parse(String(fake.calls[0].init?.body)).messages[0];
    expect(sent.parts.map((p: { type: string }) => p.type)).toEqual(["file", "text"]);
    expect(screen.getByText("runbook.md")).toBeInTheDocument();
  });
});
