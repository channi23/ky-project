/** An error whose message is safe and useful to show to the user as is. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof UserError) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  if (/network|fetch|failed to load|importScripts|NetworkError|load failed/i.test(msg)) {
    return "Could not load the text reader. Check your internet connection and try again. It is downloaded once and then cached by your browser.";
  }
  return `Something went wrong while reading this receipt (${msg}). Please try again or use a different photo.`;
}
