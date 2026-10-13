import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsView } from "../src/components/SettingsView";
import { setAdminToken, type SettingView } from "../src/api";
import { installFakeApi, json } from "./support/fake-api";

const SETTINGS: SettingView[] = [
  {
    key: "LLM_MODEL",
    group: "Primary model",
    label: "Model",
    description: "Model id to request.",
    kind: "text",
    live: true,
    fallback: "auto-discovered",
    source: "environment",
    value: "deepseek-chat",
  },
  {
    key: "LLM_API_KEY",
    group: "Primary model",
    label: "API key",
    description: "Sent to the endpoint.",
    kind: "secret",
    live: true,
    source: "settings",
    isSet: true,
  },
  {
    key: "QUERY_CACHE",
    group: "Memory layers",
    label: "Query cache",
    description: "Repeated questions answer from cache.",
    kind: "boolean",
    live: true,
    fallback: "true",
    source: "default",
    value: "",
  },
  {
    key: "RATE_LIMIT",
    group: "Rate limits",
    label: "Agent requests per window",
    description: "Per client.",
    kind: "count",
    live: false,
    fallback: "60",
    source: "default",
    value: "",
  },
];

/** The admin route: 401 without the right token, then the settings. */
function adminRoute(writable = true) {
  return (_url: URL, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (auth !== "Bearer admin-token") return json({ error: "unauthorized" }, 401);
    if (init?.method === "PUT") {
      return json({
        applied: ["LLM_MODEL"],
        restart: ["RATE_LIMIT"],
        writable,
        settings: SETTINGS,
      });
    }
    return json({ writable, settings: SETTINGS });
  };
}

async function unlock(token = "admin-token") {
  fireEvent.change(await screen.findByLabelText("Admin token"), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock settings" }));
}

describe("SettingsView", () => {
  it("explains how to enable settings when the server has none", async () => {
    setAdminToken("");
    installFakeApi({ "/admin/settings": json({ error: "not found" }, 404) });
    render(<SettingsView onSaved={() => {}} />);
    expect(await screen.findByText(/turned off on this server/)).toBeInTheDocument();
  });

  it("asks for the admin token, and says when it is wrong", async () => {
    setAdminToken("");
    installFakeApi({ "/admin/settings": adminRoute() });
    render(<SettingsView onSaved={() => {}} />);
    await unlock("wrong");
    expect(await screen.findByRole("alert")).toHaveTextContent("That token was not accepted.");
    await unlock();
    expect(await screen.findByRole("region", { name: "Primary model" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Lock" }));
    expect(await screen.findByLabelText("Admin token")).toBeInTheDocument();
  });

  it("collects changes into one batch and reports what needs a restart", async () => {
    setAdminToken("admin-token");
    const fake = installFakeApi({ "/admin/settings": adminRoute() });
    const onSaved = vi.fn();
    render(<SettingsView onSaved={onSaved} />);

    const model = await screen.findByLabelText("Model, Primary model");
    expect(model).toHaveValue("deepseek-chat");
    // A secret is never shown, only whether it is set.
    expect(screen.getByLabelText("API key, Primary model")).toHaveValue("");
    expect(screen.getByLabelText("API key, Primary model")).toHaveAttribute(
      "placeholder",
      expect.stringMatching(/set/)
    );

    fireEvent.change(model, { target: { value: "deepseek-reasoner" } });
    fireEvent.change(screen.getByLabelText("Query cache, Memory layers"), {
      target: { value: "false" },
    });
    fireEvent.change(screen.getByLabelText("Agent requests per window, Rate limits"), {
      target: { value: "10" },
    });
    const keyRow = screen
      .getByLabelText("API key, Primary model")
      .closest("div.grid") as HTMLElement;
    fireEvent.click(within(keyRow).getByRole("button", { name: "Reset" }));
    expect(screen.getByText("4 unsaved changes")).toBeInTheDocument();

    // Undo takes one change back out of the batch.
    const cacheRow = screen
      .getByLabelText("Query cache, Memory layers")
      .closest("div.grid") as HTMLElement;
    fireEvent.click(within(cacheRow).getByRole("button", { name: "Undo" }));
    expect(screen.getByText("3 unsaved changes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Restart Myzel for RATE_LIMIT/)).toBeInTheDocument();
    const put = fake.calls.find((c) => c.init?.method === "PUT")!;
    expect(JSON.parse(String(put.init?.body))).toEqual({
      changes: { LLM_MODEL: "deepseek-reasoner", RATE_LIMIT: "10", LLM_API_KEY: null },
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("shows the server's reason when a save is refused, and can discard", async () => {
    setAdminToken("admin-token");
    installFakeApi({
      "/admin/settings": (_url: URL, init?: RequestInit) =>
        init?.method === "PUT"
          ? json({ error: "LLM_TIMEOUT must be a duration" }, 400)
          : json({ writable: true, settings: SETTINGS }),
    });
    render(<SettingsView onSaved={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Model, Primary model"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("LLM_TIMEOUT must be a duration");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByText("No changes")).toBeInTheDocument();
    expect(screen.getByLabelText("Model, Primary model")).toHaveValue("deepseek-chat");
  });

  it("is read-only without a settings file", async () => {
    setAdminToken("admin-token");
    installFakeApi({ "/admin/settings": adminRoute(false) });
    render(<SettingsView onSaved={() => {}} />);
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
    expect(screen.getByLabelText("Model, Primary model")).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
  });
});
