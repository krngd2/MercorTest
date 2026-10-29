import assert from "node:assert/strict";
import { test } from "node:test";
import { answerWithContext, rewriteQuery } from "../lib/rag/chat";
import type { RetrievedChunk } from "../lib/rag/search";
import { respondToMessage } from "../lib/rag/pipeline";

const chunks: RetrievedChunk[] = [{
  chunkId: "c1", documentId: "d1", documentName: "costs.md",
  text: "Cloud compute cost $412k.", headingPath: [], page: 1,
  chunkIndex: 0, score: 1, matchedBy: ["vector"],
}];

test("conditional document retrieval", async (t) => {
  const originalFetch = globalThis.fetch;
  let responses: string[] = [];
  const requests: { messages: { role: string; content: string }[] }[] = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const content = responses.shift();
    assert.notEqual(content, undefined, "unexpected extra completion request");
    return Response.json({ choices: [{ message: { content } }] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const noSearch = async (): Promise<never> => { throw new Error("must not search"); };

  await t.test("greetings get the model's reply with no document access", async () => {
    responses = ['{"task":"conversation","route":"CHAT"}', 'Hi! How can I help?'];
    const result = await respondToMessage([{ role: "user", content: "hi" }], noSearch);
    assert.equal(result.answer, "Hi! How can I help?");
    assert.equal(result.mode, "direct");
    assert.deepEqual(result.sources, []);
    assert.equal(result.scanned, 0);
  });
  await t.test("the model routes Hello and social variants before generating a reply", async () => {
    for (const content of ["Hello", "HELLO!", "Hello 👋", "Hey there!", "Good morning", "Thanks!"]) {
      responses = ['{"task":"greeting","route":"CHAT"}', "Hello! How can I help?"];
      const before = requests.length;
      const result = await respondToMessage([
        { role: "user", content: "Summarise my report" },
        { role: "assistant", content: "I couldn't find that in your documents." },
        { role: "user", content },
      ], noSearch);
      assert.equal(result.mode, "direct");
      assert.equal(result.answer, "Hello! How can I help?");
      assert.equal(requests.length, before + 2);
      assert.equal(requests.at(-1)?.messages.at(-1)?.content, content);
      assert.equal(requests.at(-1)?.messages.length, 4);
    }
  });
  await t.test("a greeting with a document question still allows retrieval", async () => {
    responses = ['{"task":"read document","route":"SEARCH"}', '{"answer":"Cloud compute cost $412k.","source":1}'];
    const result = await respondToMessage([
      { role: "user", content: "Hello, what did compute cost in my report?" },
    ], async (query) => ({ chunks, query, scanned: 1, keywordUsed: true }));
    assert.equal(result.mode, "documents");
    assert.equal(result.answer, "Cloud compute cost $412k. [1]");
  });
  await t.test("routing always follows the model decision, with no greeting override", async () => {
    responses = ['{"task":"model requested retrieval","route":"SEARCH"}'];
    let searched = false;
    const result = await respondToMessage([{ role: "user", content: "Hello" }], async (query) => {
      searched = true;
      return { chunks: [], query, scanned: 0, keywordUsed: false };
    });
    assert.equal(searched, true);
    assert.equal(result.mode, "documents");
  });
  await t.test("general questions retain conversation context without retrieval", async () => {
    responses = ['{"task":"conversation","route":"CHAT"}', 'A vector is a list of numbers.'];
    await respondToMessage([
      { role: "user", content: "Explain embeddings" },
      { role: "assistant", content: "Embeddings are vectors." },
      { role: "user", content: "What is a vector?" },
    ], noSearch);
    assert.equal(requests.at(-1)?.messages.at(-3)?.content, "Explain embeddings");
  });
  await t.test("document questions retrieve and return validated citations", async () => {
    responses = ['{"task":"read document","route":"SEARCH"}', '{"answer":"Cloud compute cost $412k.","source":1}'];
    let searched = 0;
    const result = await respondToMessage([
      { role: "user", content: "What did compute cost?" },
    ], async (query) => {
      searched += 1;
      assert.equal(query, "What did compute cost?");
      return { chunks, query, scanned: 1, keywordUsed: true };
    });
    assert.equal(searched, 1);
    assert.equal(result.mode, "documents");
    assert.equal(result.answer, "Cloud compute cost $412k. [1]");
    assert.equal(result.sources[0].documentName, "costs.md");
  });
  await t.test("document follow-ups are rewritten before searching", async () => {
    responses = ['{"task":"read document","route":"SEARCH"}', 'Cloud compute cost in 2025', '{"answer":"Cloud compute cost $412k.","source":1}'];
    await respondToMessage([
      { role: "user", content: "What was the biggest cost?" },
      { role: "assistant", content: "Compute." },
      { role: "user", content: "How much was it?" },
    ], async (query) => {
      assert.equal(query, "Cloud compute cost in 2025");
      return { chunks, query, scanned: 1, keywordUsed: false };
    });
  });
  await t.test("missing document evidence keeps the existing refusal", async () => {
    responses = ['{"task":"read document","route":"SEARCH"}'];
    const result = await respondToMessage([{ role: "user", content: "Summarise my report" }], async (query) => ({
      chunks: [], query, scanned: 0, keywordUsed: true,
    }));
    assert.match(result.answer, /^I couldn't find that/);
    assert.deepEqual(result.sources, []);
  });
  await t.test("malformed decisions retry without triggering retrieval", async () => {
    responses = ['invalid', '{"task":"conversation","route":"CHAT"}', 'Hello!'];
    assert.equal((await respondToMessage([{ role: "user", content: "Explain vectors" }], noSearch)).answer, "Hello!");
    responses = ['invalid', '{"action":"unknown"}'];
    await assert.rejects(() => respondToMessage([{ role: "user", content: "Explain vectors" }], noSearch), /could not decide/);
  });
});

test("document answer validation", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let responses: string[] = [];
  globalThis.fetch = async () => {
    calls += 1;
    const content = responses.shift();
    assert.notEqual(content, undefined, "unexpected extra completion request");
    return Response.json({ choices: [{ message: { content } }] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const ask = () => answerWithContext({ question: "What did compute cost?", chunks });

  await t.test("retries citation-only output and renders validated JSON", async () => {
    responses = ["[1]", '{"answer":"Cloud compute cost $412k.","source":1}'];
    calls = 0;
    const result = await ask();
    assert.equal(result.answer, "Cloud compute cost $412k. [1]");
    assert.equal(calls, 2);
  });
  await t.test("rejects bare citations even inside valid JSON", async () => {
    responses = ['{"answer":"[1]","source":1}', '{"answer":"[1]","source":1}'];
    calls = 0;
    await assert.rejects(ask, /could not produce a valid document answer/);
    assert.equal(calls, 2);
  });
  await t.test("rejects nonexistent citations without inventing a replacement", async () => {
    responses = ['{"answer":"The total was $412k.","source":7}', '{"answer":"The total was $412k.","source":0}'];
    await assert.rejects(ask, /could not produce a valid document answer/);
  });
  await t.test("repairs a wrong source only for an unambiguous literal extract", async () => {
    responses = ['{"answer":"Cloud compute cost $412k.","source":2}'];
    assert.equal((await ask()).answer, "Cloud compute cost $412k. [1]");
  });
  await t.test("does not treat a partial number as a matching extract", async () => {
    responses = ['{"answer":"4","source":7}', '{"answer":"4","source":7}'];
    await assert.rejects(ask, /could not produce a valid document answer/);
  });
  await t.test("accepts fenced JSON and avoids duplicate model citations", async () => {
    responses = ['```json\n{"answer":"Compute cost $412k. [7]","source":1}\n```'];
    assert.equal((await ask()).answer, "Compute cost $412k. [1]");
  });
  await t.test("refusals have no sources even if the model supplies a source", async () => {
    responses = ['{"answer":"Not found in documents.","source":1}'];
    const result = await ask();
    assert.match(result.answer, /^I couldn't find that/);
    assert.deepEqual(result.sources, []);
  });
  await t.test("no retrieved documents skips inference", async () => {
    calls = 0;
    const result = await answerWithContext({ question: "Anything?", chunks: [] });
    assert.match(result.answer, /^I couldn't find that/);
    assert.equal(calls, 0);
  });
  await t.test("repetitive query rewrites fall back to the user's question", async () => {
    responses = ["cost headcount headcount headcount headcount"];
    const result = await rewriteQuery([
      { role: "user", content: "What did compute cost?" },
      { role: "assistant", content: "$412k" },
      { role: "user", content: "How did headcount change?" },
    ]);
    assert.equal(result, "How did headcount change?");
  });
});
