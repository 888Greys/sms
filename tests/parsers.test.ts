import test from "node:test";
import assert from "node:assert/strict";
import { parseBatchFromNumberId } from "../src/lib/keys.js";
import { parseActionData, parseClaimArg, parseForceReleaseArg } from "../src/lib/parsers.js";

test("parseClaimArg parses valid claim command", () => {
  assert.equal(parseClaimArg("/claim 3", 1, 10), 3);
  assert.equal(parseClaimArg("/claim@mybot 10", 1, 10), 10);
});

test("parseClaimArg rejects invalid values", () => {
  assert.equal(parseClaimArg("/claim", 1, 10), null);
  assert.equal(parseClaimArg("/claim abc", 1, 10), null);
  assert.equal(parseClaimArg("/claim 0", 1, 10), null);
  assert.equal(parseClaimArg("/claim 11", 1, 10), null);
});

test("parseForceReleaseArg parses valid admin command", () => {
  assert.equal(parseForceReleaseArg("/force_release 2", 1, 10), 2);
});

test("parseActionData parses sent and skip callbacks", () => {
  assert.deepEqual(parseActionData("sent:b2:n18"), {
    kind: "sent",
    numberId: "b2:n18"
  });
  assert.deepEqual(parseActionData("skip:b7:n1"), {
    kind: "skip",
    numberId: "b7:n1"
  });
});

test("parseActionData rejects unknown callbacks", () => {
  assert.equal(parseActionData("progress"), null);
  assert.equal(parseActionData("bad:b1:n2"), null);
});

test("parseBatchFromNumberId parses valid ids and rejects invalid ids", () => {
  assert.equal(parseBatchFromNumberId("b1:n1"), 1);
  assert.equal(parseBatchFromNumberId("b10:n200"), 10);
  assert.equal(parseBatchFromNumberId("b1"), null);
  assert.equal(parseBatchFromNumberId("hello"), null);
});
