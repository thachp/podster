// Offline checks only. Nothing here calls GitHub.
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { appJwt, looksLikeTestOrg, orgAllowed } from "./spike.mjs";

test("the App JWT verifies with the key's public half and carries the App ID", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" });
  const jwt = appJwt(42, pem, 1_000_000);
  const [head, body, sig] = jwt.split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${head}.${body}`).verify(publicKey, sig, "base64url"));
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.deepEqual(claims, { iat: 999_940, exp: 1_000_540, iss: "42" });
});

test("only organizations that look like test ones are accepted", () => {
  for (const ok of ["podster-spike", "podster-test", "test-podster", "podster-sandbox", "spike"]) {
    assert.ok(looksLikeTestOrg(ok), ok);
  }
  for (const bad of ["podster", "podster-rooms", "contest", "testimony", "podster_test", "test/../podster", "", undefined]) {
    assert.ok(!looksLikeTestOrg(bad), String(bad));
  }
});

test("another organization runs only when the owner repeats its name exactly", () => {
  assert.ok(orgAllowed("podster-spike", undefined));
  assert.ok(orgAllowed("podsterx", "podsterx"));
  for (const [org, confirm] of [["podsterx", undefined], ["podsterx", ""], ["podsterx", "Podsterx"], ["podster", "podsterx"], [undefined, undefined], ["", ""], ["a/b", "a/b"]]) {
    assert.ok(!orgAllowed(org, confirm), `${org} ${confirm}`);
  }
});
