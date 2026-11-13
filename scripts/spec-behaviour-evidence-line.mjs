export function evidenceLine(id, command, expected, observed, passed) {
  return { id, command, expected, observed, result: passed ? "PASS" : "FAIL" };
}

export function notVerified(id, command, expected, observed) {
  return { id, command, expected, observed, result: "NOT VERIFIED" };
}
