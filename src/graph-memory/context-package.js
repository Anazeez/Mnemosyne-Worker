export const DEFAULT_CONTEXT_BUDGET_TOKENS = 2_000;
export const MIN_CONTEXT_BUDGET_TOKENS = 256;
export const MAX_CONTEXT_BUDGET_TOKENS = 2_000;

export function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 4);
}

export function buildContextPackage({
  assertions = [],
  conflicts = [],
  budgetTokens = DEFAULT_CONTEXT_BUDGET_TOKENS
}) {
  const accepted = assertions.filter(item => item?.state === "accepted");
  const result = {
    assertions: [],
    conflicts: [],
    budget_tokens: budgetTokens,
    estimated_tokens: 0,
    truncated: false,
    insufficient: false
  };

  for (const assertion of accepted) {
    if (!Array.isArray(assertion.evidence) || assertion.evidence.length === 0) {
      result.truncated = true;
      continue;
    }
    const candidate = {
      ...result,
      assertions: [...result.assertions, assertion]
    };
    if (estimatedPackageTokens(candidate) <= budgetTokens) {
      result.assertions.push(assertion);
    } else {
      result.truncated = true;
    }
  }

  const selected = new Set(
    result.assertions.map(assertion => assertion.assertion_id)
  );
  for (const conflict of conflicts) {
    const ids = Array.isArray(conflict?.assertion_ids)
      ? conflict.assertion_ids
      : [];
    if (!ids.every(id => selected.has(id))) {
      result.truncated = true;
      continue;
    }
    const candidate = {
      ...result,
      conflicts: [...result.conflicts, conflict]
    };
    if (estimatedPackageTokens(candidate) <= budgetTokens) {
      result.conflicts.push(conflict);
    } else {
      result.truncated = true;
    }
  }

  result.insufficient = accepted.length > 0 && result.assertions.length === 0;
  result.truncated = result.truncated ||
    result.assertions.length < accepted.length ||
    result.conflicts.length < conflicts.length;
  result.estimated_tokens = estimatedPackageTokens(result);

  while (
    result.estimated_tokens > budgetTokens &&
    result.assertions.length > 0
  ) {
    result.assertions.pop();
    result.conflicts = result.conflicts.filter(conflict =>
      conflict.assertion_ids.every(id =>
        result.assertions.some(assertion => assertion.assertion_id === id)
      )
    );
    result.truncated = true;
    result.insufficient = result.assertions.length === 0 && accepted.length > 0;
    result.estimated_tokens = estimatedPackageTokens(result);
  }

  return result;
}

function estimatedPackageTokens(value) {
  let estimate = 0;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    estimate = estimateTokens({ ...value, estimated_tokens: estimate });
  }
  return estimate;
}
