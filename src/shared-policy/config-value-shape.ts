// Shared "what does an invalid override value look like, in a message a
// human can fix from" predicates: reused identically by the persona config
// validator (`application-config.service.ts`) and the steering config
// validator (`steering-user-config.ts`).

/** Renders a JS value's type/shape for an error message. */
export function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/** The plain-object-vs-array-vs-null predicate used before validating an
 *  override's shape. */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
