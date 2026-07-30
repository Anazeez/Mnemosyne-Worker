import assert from "node:assert/strict";
import test from "node:test";

import { fuseRankedAssertionIds } from "../src/graph-memory/ranking.js";

test("reciprocal-rank fusion is deterministic and deduplicated", () => {
  assert.deepEqual(
    fuseRankedAssertionIds({
      lexicalIds: ["a2", "a1"],
      semanticMatches: [
        { id: "a1", score: 0.91 },
        { id: "a3", score: 0.88 }
      ],
      limit: 3
    }),
    ["a1", "a2", "a3"]
  );
});

test("semantic candidates outside the authorized D1 set are discarded", () => {
  assert.deepEqual(
    fuseRankedAssertionIds({
      lexicalIds: ["a1"],
      semanticMatches: [
        { id: "foreign", score: 0.99 },
        { id: "a2", score: 0.90 }
      ],
      allowedAssertionIds: new Set(["a1", "a2"]),
      limit: 10
    }),
    ["a1", "a2"]
  );
});
