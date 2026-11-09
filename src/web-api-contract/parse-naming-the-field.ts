import type { z } from "zod";

const WHOLE_VALUE_NAME = "(the whole value)";

function issueNamingTheField(issue: z.core.$ZodIssue): string {
  const field = issue.path.join(".") || WHOLE_VALUE_NAME;
  return `${field}: ${issue.message}`;
}

export function parseNamingTheField<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  boundary: string,
  createError: (message: string) => Error = (message) => new Error(message),
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const problems = result.error.issues.map(issueNamingTheField).join("; ");
  throw createError(`${boundary} does not match its contract: ${problems}`);
}
