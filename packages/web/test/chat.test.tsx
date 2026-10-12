import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatPanel, createChat } from "../src/components/ChatPanel";
import type { AppConfig } from "../src/api";
import { installFakeApi, json, uiStream } from "./support/fake-api";

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

function send(text: string) {
  fireEvent.change(screen.getByLabelText("Message the agent"), { target: { value: text } });
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

    send("Dana is on call");
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
    send("hi");
    await screen.findByText("ok");
    expect(JSON.parse(String(fake.calls[0].init?.body)).model).toBe("other");
  });

  it("shows an error when the request fails", async () => {
    installFakeApi({ "/api/chat": json({ error: "message too long" }, 413) });
    render(<ChatPanel chat={createChat(() => {})} config={CONFIG} onOpenConcept={() => {}} />);
    send("x");
    expect(await screen.findByRole("alert")).toHaveTextContent("message too long");
  });

  it("explains a run that ended without an answer", async () => {
    installFakeApi({
      "/api/chat": () => uiStream([{ type: "start" }, { type: "abort", reason: "TimeoutError" }]),
    });
    render(<ChatPanel chat={createChat(() => {})} config={CONFIG} onOpenConcept={() => {}} />);
    send("x");
    expect(await screen.findByRole("alert")).toHaveTextContent("No answer");
  });
});
