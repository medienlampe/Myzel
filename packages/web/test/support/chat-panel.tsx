import { useState, type ComponentProps } from "react";
import { ChatPanel } from "../../src/components/ChatPanel";

/** ChatPanel with the model choice held here, as App holds it. */
export function TestChatPanel(
  props: Omit<ComponentProps<typeof ChatPanel>, "model" | "onModelChange">
) {
  const [model, setModel] = useState("");
  return <ChatPanel {...props} model={model} onModelChange={setModel} />;
}
