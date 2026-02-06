import test from "node:test";
import assert from "node:assert/strict";

import { collectGlmResponse } from "../src/proxy/messages.js";

test("collectGlmResponse avoids redundant getCurrentMessageId when includeHistory is true", async () => {
  let sendArgs: any = null;
  const client: any = {
    async getCurrentMessageId() {
      throw new Error("getCurrentMessageId should not be called when includeHistory=true");
    },
    async *sendMessage(options: any) {
      sendArgs = options;
      yield { type: "content", data: "ok" };
    },
  };

  const result = await collectGlmResponse(
    client,
    "chat_test",
    [{ role: "user", content: "hi" }],
    { includeHistory: true, includeThinking: false },
  );

  assert.equal(result, "ok");
  assert.equal(sendArgs?.includeHistory, true);
  assert.equal(sendArgs?.parentMessageId, null);
});

