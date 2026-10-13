import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Types into the chat composer. It is a ProseMirror editor, not a form field,
 * so fireEvent.change cannot fill it — user-event's keyboard can. `{` and `[`
 * are user-event key syntax: double them for the literal character.
 */
export async function typeMessage(text: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("textbox", { name: "Message the agent" }));
  await user.keyboard(text);
  return user;
}
