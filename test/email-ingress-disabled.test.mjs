import assert from "node:assert/strict";
import test from "node:test";

import { loadWorker } from "./helpers/worker-harness.mjs";

const rejection = "Direct email ingress disabled; route through mnemosyne-mail-gateway";

function fakeEmailMessage() {
  return {
    from: "architectus",
    to: "hearken",
    rawSize: 42,
    raw: new ReadableStream({ start(controller) { controller.close(); } }),
    headers: new Headers({ subject: "Urgent clinic invocation" }),
    forwardCalls: [],
    rejectReason: null,
    setReject(reason) { this.rejectReason = reason; },
    async forward(destination) { this.forwardCalls.push(destination); },
  };
}

test("Mnemosyne Worker rejects direct raw email without reading or forwarding it", async () => {
  const worker = await loadWorker();
  const message = fakeEmailMessage();
  await worker.email(message, {
    MATRIX_MAIL_FORWARD_TO: "configured-mirror",
    MATRIX_EMAIL_QUEUE: { async send() { throw new Error("must not queue"); } },
  }, { waitUntil() { throw new Error("must not forward"); } });

  assert.equal(message.rejectReason, rejection);
  assert.deepEqual(message.forwardCalls, []);
});

test("obsolete raw-email queue payloads are acknowledged without persistence", async () => {
  const worker = await loadWorker();
  let acked = 0;
  let retried = 0;
  const slot = {
    id: "queue-email-1",
    body: { type: "email.ingress.v1", raw_body: "must not persist" },
    ack() { acked += 1; },
    retry() { retried += 1; },
  };
  await worker.queue({ messages: [slot] }, { DB: {} });
  assert.equal(acked, 1);
  assert.equal(retried, 0);
});
