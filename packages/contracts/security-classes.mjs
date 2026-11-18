// Operations that take an assertion of their own instead of an identity's: the provider delivery (M5 step 5) and Runner's
// pairing redemption (M7 step 5). An operation in such a class lists exactly its one scheme, in one requirement, and
// nothing else, so it can never also be reached with an identity; and no operation outside the class lists that scheme,
// alone or as one alternative.

/**
 * `operations` maps an operation ID to `{ op }`, as check.mjs builds it. `classes` is `[{ name, ids, scheme }]`.
 * Answers a list of problems, each starting with the operation's ID.
 */
export function exclusiveSchemeProblems(operations, classes) {
  const problems = [];
  for (const { name, ids, scheme } of classes) {
    for (const id of ids) {
      const found = operations.get(id);
      if (!found) { problems.push(`${id}: ${name} operation doesn't exist`); continue; }
      const security = found.op.security;
      const only = Array.isArray(security) && security.length === 1 && Object.keys(security[0] ?? {}).join() === scheme;
      if (!only) problems.push(`${id}: ${name} must list only the ${scheme} scheme`);
    }
    for (const [id, { op }] of operations) {
      if (!ids.includes(id) && op.security?.some((requirement) => scheme in requirement)) problems.push(`${id}: takes the ${scheme} scheme but isn't ${name}`);
    }
  }
  return problems;
}
