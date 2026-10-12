/**
 * Reload the page. Its own module so tests can replace it: jsdom cannot
 * navigate, and window.location cannot be stubbed.
 */
export function reloadPage(): void {
  window.location.reload();
}
