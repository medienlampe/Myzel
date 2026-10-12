import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "../src/App";
import { installFakeApi, json, standardRoutes } from "./support/fake-api";

vi.mock("../src/reload", () => ({ reloadPage: vi.fn() }));
const { reloadPage } = await import("../src/reload");

async function renderApp(routes = standardRoutes()) {
  const fake = installFakeApi(routes);
  render(<App />);
  await screen.findByText("Billing API");
  return fake;
}

const explorer = () => within(screen.getByRole("region", { name: "Explorer" }));

describe("App", () => {
  it("loads the bundle, shows conformance and opens a concept from the tree", async () => {
    await renderApp();
    expect(screen.getByText("conformant")).toBeInTheDocument();
    expect(screen.getByText("Select a concept, or ask the agent.")).toBeInTheDocument();
    fireEvent.click(explorer().getByText("Billing API"));
    expect(
      await screen.findByRole("heading", { name: "Billing API", level: 1 })
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Concept", level: 2 })).toBeInTheDocument();
  });

  it("searches as you type, opens a hit, and says when nothing matches", async () => {
    const fake = await renderApp();
    fireEvent.change(screen.getByLabelText("Search concepts"), { target: { value: "charges" } });
    expect(await screen.findByText("charges")).toBeInTheDocument();
    expect(fake.calls.some((c) => c.path === "/api/search?q=charges")).toBe(true);
    fireEvent.click(screen.getByText("charges"));
    expect(
      await screen.findByRole("heading", { name: "Billing API", level: 1 })
    ).toBeInTheDocument();

    fake.set("/api/search", []);
    fireEvent.change(screen.getByLabelText("Search concepts"), { target: { value: "zzz" } });
    expect(await screen.findByText("No matches.")).toBeInTheDocument();
  });

  it("switches the view between the log and the graph", async () => {
    await renderApp();
    fireEvent.click(explorer().getByRole("button", { name: "Log" }));
    expect(await screen.findByRole("heading", { name: "Update Log" })).toBeInTheDocument();
    fireEvent.click(explorer().getByRole("button", { name: "Graph" }));
    expect(await screen.findByText("Query paths")).toBeInTheDocument();
    fireEvent.click(explorer().getByText("log.md"));
    expect(await screen.findByRole("heading", { name: "Update Log" })).toBeInTheDocument();
  });

  it("shows a load error and clears it when another view is chosen", async () => {
    const routes = standardRoutes();
    routes["/api/concept"] = json({ error: "boom" }, 500);
    await renderApp(routes);
    fireEvent.click(explorer().getByText("Billing API"));
    expect(await screen.findByText(/500/)).toBeInTheDocument();
    fireEvent.click(explorer().getByRole("button", { name: "Log" }));
    await waitFor(() => expect(screen.queryByText(/500/)).not.toBeInTheDocument());
  });

  it("closes, reopens and resets panels from the top bar", async () => {
    await renderApp();
    const nav = within(screen.getByRole("navigation", { name: "Panels" }));
    fireEvent.click(nav.getByRole("button", { name: "Chat" }));
    expect(screen.queryByRole("region", { name: "Agent chat" })).not.toBeInTheDocument();
    expect(nav.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(nav.getByRole("button", { name: "Chat" }));
    expect(screen.getByRole("region", { name: "Agent chat" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move Agent chat left" }));
    fireEvent.click(nav.getByRole("button", { name: "Reset layout" }));
    const titles = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(titles).toEqual(["Explorer", "View", "Agent chat"]);
  });

  it("asks for the AUTH_TOKEN and reloads once a key is accepted", async () => {
    let authorized = false;
    const routes = standardRoutes();
    const guarded = (body: unknown) => () =>
      authorized ? json(body) : json({ error: "unauthorized", mode: "single" }, 401);
    routes["/api/tree"] = guarded(routes["/api/tree"]);
    routes["/api/profile"] = guarded({ mode: "single", profile: null });
    installFakeApi(routes);
    render(<App />);
    expect(await screen.findByText(/AUTH_TOKEN/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That key was not accepted.");
    expect(sessionStorage.getItem("myzel-token")).toBeNull();

    authorized = true;
    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "right" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(reloadPage).toHaveBeenCalled());
    expect(sessionStorage.getItem("myzel-token")).toBe("right");
  });

  it("asks for a profile key in profile mode and reports an unreachable server", async () => {
    installFakeApi({
      "/api/tree": json({ error: "unauthorized", mode: "profiles" }, 401),
      "/api/profile": () => {
        throw new TypeError("network down");
      },
    });
    render(<App />);
    expect(await screen.findByText(/hosts several memories/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Profile API key"), { target: { value: "myz_x" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server");
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it("names the open profile and switches profiles by forgetting the key", async () => {
    const routes = standardRoutes();
    routes["/api/profile"] = { mode: "profiles", profile: "work" };
    sessionStorage.setItem("myzel-token", "myz_work");
    await renderApp(routes);
    expect(reloadPage).not.toHaveBeenCalled();
    expect(await screen.findByText("work")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "switch" }));
    expect(sessionStorage.getItem("myzel-token")).toBeNull();
    expect(reloadPage).toHaveBeenCalled();
  });
});
