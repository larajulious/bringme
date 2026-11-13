import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { screenChannelClaims } from "../lib/game/jwt.ts";
import { formatScreenToken, normalizeScreenToken, screenPath } from "../lib/screen/token.ts";

describe("TV link tokens", () => {
  it("accepts what a person types on a TV remote, rejects anything else", () => {
    assert.equal(normalizeScreenToken("abcd-efgh-jkmn"), "abcdefghjkmn");
    assert.equal(normalizeScreenToken("ABCD EFGH JKMN"), "abcdefghjkmn");
    assert.equal(normalizeScreenToken("abcdefghjkm"), null, "too short");
    assert.equal(normalizeScreenToken("abcdefghjkmo"), null, "look-alike letter");
    assert.equal(normalizeScreenToken("../../etc/pas"), null);
  });
  it("formats in groups of four for reading out", () => {
    assert.equal(formatScreenToken("abcdefghjkmn"), "abcd-efgh-jkmn");
    assert.equal(screenPath("abcdefghjkmn"), "/tv/abcd-efgh-jkmn");
  });
  it("Realtime claims: no database role, bound to one game and the current link", () => {
    const c = screenChannelClaims({ gameId: "g1", screenToken: "abcdefghjkmn", nowSeconds: 100 });
    assert.equal(c.role, "anon");
    assert.equal(c.kind, "screen");
    assert.equal(c.game_id, "g1");
    assert.equal(c.screen_token, "abcdefghjkmn");
    assert.equal(c.exp - c.iat, 3600);
  });
});
