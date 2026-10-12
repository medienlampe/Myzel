import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GraphView } from "../src/components/GraphView";
import { installFakeApi, json, standardRoutes } from "./support/fake-api";

async function renderGraph(routes = standardRoutes()) {
  const fake = installFakeApi(routes);
  const onNavigate = vi.fn();
  const view = render(<GraphView refreshKey={0} onNavigate={onNavigate} />);
  await screen.findByText("Billing API");
  return { fake, onNavigate, view };
}

describe("GraphView", () => {
  it("draws concepts with a type legend and marks orphans", async () => {
    await renderGraph();
    expect(screen.getByText("Customers")).toBeInTheDocument();
    for (const type of ["API", "Table", "Note"]) expect(screen.getByText(type)).toBeInTheDocument();
    expect(screen.getByText("orphan (unlinked)")).toBeInTheDocument();
    expect(screen.getByText(/3 concepts/)).toBeInTheDocument();
  });

  it("opens a concept on click and highlights neighbours on hover", async () => {
    const { onNavigate, view } = await renderGraph();
    const node = screen.getByText("Billing API").closest("g")!;
    fireEvent.pointerEnter(node);
    expect(view.container.querySelector("[opacity='0.25']")).toBeInTheDocument();
    fireEvent.pointerLeave(node);
    fireEvent.click(node);
    expect(onNavigate).toHaveBeenCalledWith("/apis/billing.md");
  });

  it("zooms, pans, drags nodes and resets the camera", async () => {
    const { view } = await renderGraph();
    const scene = () => view.container.querySelector("svg g[transform]")!.getAttribute("transform");
    fireEvent.click(screen.getByTitle("Zoom in"));
    expect(scene()).toContain("scale(1.3)");
    fireEvent.click(screen.getByTitle("Zoom out"));
    fireEvent.wheel(view.container.querySelector("svg")!, { deltaY: -100 });
    expect(scene()).toContain("scale(1.15");

    const svg = view.container.querySelector("svg")!;
    fireEvent.pointerDown(svg, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 60, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(svg);
    const node = screen.getByText("Customers").closest("g")!;
    fireEvent.pointerDown(node, { clientX: 0, clientY: 0, pointerId: 2 });
    fireEvent.pointerMove(svg, { clientX: 5, clientY: 5, pointerId: 2 });
    fireEvent.pointerUp(svg);
    fireEvent.pointerMove(svg, { clientX: 9, clientY: 9 }); // no drag in progress: ignored

    fireEvent.click(screen.getByTitle("Reset camera"));
    expect(scene()).toBe("translate(0,0) scale(1)");
  });

  it("replays a recorded query path with its token usage", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await renderGraph();
    expect(screen.getByText("6.2k→320 tok")).toBeInTheDocument();
    fireEvent.click(screen.getByText("How does billing work?"));
    await screen.findByText("search → billing.md", { selector: "div" });
    expect(screen.getAllByText("6.2k→320 tok")).toHaveLength(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000); // the sweep plays to the end
    });
    expect(screen.getByText("1.0/1 hops")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Play the traversal")); // replays from the start
    fireEvent.click(screen.getByTitle("Pause"));
    fireEvent.change(screen.getByRole("slider"), { target: { value: "50" } });
    expect(screen.getByText("0.5/1 hops")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close path replay" }));
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Query paths"));
    expect(screen.queryByText("How does billing work?")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("ignores a trace that was pruned since the list loaded, and a failed graph load", async () => {
    const routes = standardRoutes();
    routes["/api/trace"] = json({ error: "trace not found" }, 404);
    const { fake } = await renderGraph(routes);
    fireEvent.click(screen.getByText("How does billing work?"));
    await waitFor(() => expect(fake.calls.some((c) => c.path === "/api/trace?id=t1")).toBe(true));
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    installFakeApi({ "/api/graph": json({ error: "boom" }, 500), "/api/traces": [] });
    render(<GraphView refreshKey={1} onNavigate={() => {}} />);
    await waitFor(() => expect(log).toHaveBeenCalledWith("graph load failed:", expect.anything()));
    expect(screen.getByText(/No recorded runs yet/)).toBeInTheDocument();
    log.mockRestore();
  });
});
