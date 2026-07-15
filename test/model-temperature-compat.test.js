const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "index.js"),
  "utf8"
);

function functionSource(name, nextName) {
  const startMarker = `async function ${name}`;
  const endMarker = nextName ? `function ${nextName}` : null;
  const start = source.indexOf(startMarker);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;

  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

function assertModelCompatibleRequest(handlerSource) {
  const endpoint = 'fetch("https://api.openai.com/v1/chat/completions"';
  assert.equal(
    handlerSource.split(endpoint).length - 1,
    1,
    "handler must contain exactly one Chat Completions request"
  );
  assert.doesNotMatch(
    handlerSource,
    /\btemperature\s*:/,
    "Ariadne requests must allow the model to use its supported default temperature"
  );
}

test("Ariadne Core Intake omits an explicit temperature", () => {
  assertModelCompatibleRequest(
    functionSource("handleAriadneCoreIntake", "handleAriadneCoreStatus")
  );
});

test("Ariadne Core Review omits an explicit temperature", () => {
  assertModelCompatibleRequest(
    functionSource("handleAriadneCoreReview", "isValidAriadneReview")
  );
});
