import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatPanel, chatErrorText, createChat } from "../src/components/ChatPanel";
import type { AppConfig } from "../src/api";
import { installFakeApi, json, uiStream } from "./support/fake-api";
import { typeMessage } from "./support/composer";

const CONFIG: AppConfig = { model: "fake-model", format: "openai", fallbackConfigured: true };

const answer = (text: string) =>
  uiStream([
    { type: "start" },
    { type: "start-step" },
    {
      type: "tool-input-available",
      toolCallId: "c1",
      toolName: "write_concept",
      input: { path: "/people/dana.md" },
    },
    { type: "tool-output-available", toolCallId: "c1", output: { written: "/people/dana.md" } },
    {
      type: "tool-input-available",
      toolCallId: "c2",
      toolName: "search_knowledge",
      input: { query: "on call" },
    },
    { type: "tool-output-available", toolCallId: "c2", output: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish-step" },
    { type: "finish" },
  ]);

async function send(text: string) {
  await typeMessage(text);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("ChatPanel", () => {
  it("sends a message, shows tool calls and the answer, then refreshes the views", async () => {
    const fake = installFakeApi({ "/api/chat": () => answer("Recorded Dana.") });
    const onRunEnd = vi.fn();
    const onOpenConcept = vi.fn();
    render(<ChatPanel chat={createChat(onRunEnd)} config={CONFIG} onOpenConcept={onOpenConcept} />);
    expect(screen.getByText(/Test the knowledge agent here/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    await send("Dana is on call");
    expect(await screen.findByText("Recorded Dana.")).toBeInTheDocument();
    expect(screen.getByText("Dana is on call")).toBeInTheDocument();
    expect(screen.getByText('"on call"')).toBeInTheDocument();
    await waitFor(() => expect(onRunEnd).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "/people/dana.md" }));
    expect(onOpenConcept).toHaveBeenCalledWith("/people/dana.md");
    expect(JSON.parse(String(fake.calls[0].init?.body)).model).toBeUndefined();
  });

  it("sends a chosen model when the server allows overrides", async () => {
    const fake = installFakeApi({ "/api/chat": () => answer("ok") });
    render(
      <ChatPanel
        chat={createChat(() => {})}
        config={{ ...CONFIG, modelOverride: true }}
        onOpenConcept={() => {}}
      />
    );
    fireEvent.change(screen.getByLabelText("Model override"), { target: { value: "other" } });
    await send("hi");
    await screen.findByText("ok");
    expect(JSON.parse(String(fake.calls[0].init?.body)).model).toBe("other");
  });

  it("shows the server's error text when the request fails", async () => {
    installFakeApi({ "/api/chat": json({ error: "message too long" }, 413) });
    render(<ChatPanel chat={createChat(() => {})} config={CONFIG} onOpenConcept={() => {}} />);
    await send("x");
    expect(await screen.findByRole("alert")).toHaveTextContent(/^message too long$/);
  });

  it("retries a failed request with the same message and model", async () => {
    let attempt = 0;
    const fake = installFakeApi({
      "/api/chat": () =>
        ++attempt === 1 ? json({ error: "model discovery failed" }, 502) : answer("Back again."),
    });
    render(
      <ChatPanel
        chat={createChat(() => {})}
        config={{ ...CONFIG, modelOverride: true }}
        onOpenConcept={() => {}}
      />
    );
    fireEvent.change(screen.getByLabelText("Model override"), { target: { value: "other" } });
    await send("Dana is on call");
    expect(await screen.findByRole("alert")).toHaveTextContent("model discovery failed");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Back again.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Dana is on call")).toHaveLength(1);
    const retried = JSON.parse(String(fake.calls[1].init?.body));
    expect(retried.model).toBe("other");
    expect(retried.messages).toHaveLength(1);
  });

  it("falls back to the raw message when the error is not JSON", () => {
    expect(chatErrorText(new Error("fetch failed"))).toBe("fetch failed");
    expect(chatErrorText(new Error('{"other":1}'))).toBe('{"other":1}');
    expect(chatErrorText(new Error(""))).toBe("The request failed.");
  });

  it("stops a running agent by aborting the request", async () => {
    let signal: AbortSignal | undefined;
    installFakeApi({
      "/api/chat": (_url: URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        // A run that never finishes on its own: only the abort ends it.
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n'));
            signal?.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError"))
            );
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
        });
      },
    });
    const onRunEnd = vi.fn();
    render(<ChatPanel chat={createChat(onRunEnd)} config={CONFIG} onOpenConcept={() => {}} />);
    await send("take your time");
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));

    expect(await screen.findByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent("No answer");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    await waitFor(() => expect(onRunEnd).toHaveBeenCalled());
  });

  it("explains a run that ended without an answer", async () => {
    installFakeApi({
      "/api/chat": () => uiStream([{ type: "start" }, { type: "abort", reason: "TimeoutError" }]),
    });
    render(<ChatPanel chat={createChat(() => {})} config={CONFIG} onOpenConcept={() => {}} />);
    await send("x");
    expect(await screen.findByRole("alert")).toHaveTextContent("No answer");
  });
});
