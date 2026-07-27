import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const fixtureUrl = new URL(
  "../test/fixtures/graph-memory-retrieval-golden.json",
  import.meta.url
);

export function evaluateCases(cases) {
  const allExpected = cases.flatMap(item =>
    item.expected_assertion_ids.map(id => [item.case_id, id])
  );
  const paraphraseExpected = cases
    .filter(item => item.kind === "paraphrase")
    .flatMap(item => item.expected_assertion_ids.map(id => [item.case_id, id]));
  const byCase = new Map(cases.map(item => [item.case_id, item]));
  const recallAt10 = recall(allExpected, byCase);
  const paraphraseRecallAt10 = recall(paraphraseExpected, byCase);
  const authorizationLeaks = cases.reduce((count, item) => {
    const forbidden = new Set(item.forbidden_assertion_ids || []);
    return count + item.retrieved_assertion_ids
      .slice(0, 10)
      .filter(id => forbidden.has(id)).length;
  }, 0);
  const budgetViolations = cases.filter(
    item => Number(item.context_tokens) > 2_000
  ).length;
  const passed = recallAt10 >= 0.95 &&
    paraphraseRecallAt10 >= 0.95 &&
    authorizationLeaks === 0 &&
    budgetViolations === 0;

  return {
    cases: cases.length,
    recall_at_10: recallAt10,
    paraphrase_recall_at_10: paraphraseRecallAt10,
    authorization_leaks: authorizationLeaks,
    budget_violations: budgetViolations,
    passed
  };
}

function recall(expectedPairs, byCase) {
  if (expectedPairs.length === 0) return 1;
  const hits = expectedPairs.filter(([caseId, expectedId]) =>
    byCase.get(caseId).retrieved_assertion_ids
      .slice(0, 10)
      .includes(expectedId)
  ).length;
  return hits / expectedPairs.length;
}

async function main() {
  const cases = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const result = evaluateCases(cases);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
