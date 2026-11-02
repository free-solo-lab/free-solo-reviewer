/** A readable message for anything thrown: an Error's message, otherwise its string form. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
