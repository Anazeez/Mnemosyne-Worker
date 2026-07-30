const RRF_K = 60;
const SEMANTIC_THRESHOLD = 0.65;

export function fuseRankedAssertionIds({
  lexicalIds = [],
  semanticMatches = [],
  allowedAssertionIds,
  limit = 10
}) {
  const scores = new Map();
  const add = (id, rank) => {
    const normalized = String(id);
    if (allowedAssertionIds && !allowedAssertionIds.has(normalized)) return;
    scores.set(normalized, (scores.get(normalized) || 0) + 1 / (RRF_K + rank));
  };

  lexicalIds.forEach((id, index) => add(id, index + 1));
  semanticMatches
    .filter(match => Number(match.score) >= SEMANTIC_THRESHOLD)
    .forEach((match, index) => add(match.id, index + 1));

  return [...scores]
    .sort(([leftId, leftScore], [rightId, rightScore]) =>
      rightScore - leftScore || leftId.localeCompare(rightId)
    )
    .slice(0, limit)
    .map(([id]) => id);
}
