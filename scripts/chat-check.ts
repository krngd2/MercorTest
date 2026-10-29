/**
 * Verifies the local MiniCPM5 chat server through the app's real answer path:
 * a grounded answer with a valid citation, a clean refusal for an unanswerable
 * question, and a follow-up query rewrite.
 *
 *   npm run chat:check
 *
 * Start the server with `npm run chat:serve` first.
 */
import { answerWithContext, rewriteQuery } from "../lib/rag/chat";
import { ragConfig } from "../lib/rag/config";
import { respondToMessage } from "../lib/rag/pipeline";
import type { RetrievedChunk } from "../lib/rag/search";

const CHUNKS: RetrievedChunk[] = [
  {
    chunkId: "c1",
    documentId: "d1",
    documentName: "costs.md",
    text: "Cloud compute was the biggest cost driver in 2025 at $412k, up 38% year over year.",
    headingPath: ["Costs", "2025"],
    page: 2,
    chunkIndex: 0,
    score: 1,
    matchedBy: ["vector"],
  },
  {
    chunkId: "c2",
    documentId: "d1",
    documentName: "costs.md",
    text: "Headcount grew from 40 to 47 people in the same period.",
    headingPath: ["Costs", "Headcount"],
    page: 3,
    chunkIndex: 1,
    score: 0.5,
    matchedBy: ["keyword"],
  },
];

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function citations(answer: string): number[] {
  return [...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number.parseInt(match[1], 10));
}

async function main() {
  console.log(`model=${ragConfig.chatModel || "(server default)"} url=${ragConfig.localChatUrl}`);

  for (const content of ["hi", "Hello", "Hello!"]) {
    const greeting = await respondToMessage([
      { role: "user", content: "Summarise my report" },
      { role: "assistant", content: "I couldn't find that in your documents." },
      { role: "user", content },
    ], async () => { throw new Error(`Greeting incorrectly searched documents: ${content}`); });
    assert(greeting.mode === "direct", "greeting should be a direct reply");
    assert(!/couldn.t find|not found|upload/i.test(greeting.answer), "greeting returned a document refusal");
    assert(greeting.sources.length === 0 && greeting.scanned === 0, "greeting should have no retrieval metadata");
    console.log(`\ngreeting (${content}): ${greeting.answer}`);
  }

  const started = performance.now();
  const grounded = await answerWithContext({
    question: "What was the biggest cost driver?",
    chunks: CHUNKS,
  });
  console.log(`\nanswer (${Math.round(performance.now() - started)}ms):\n${grounded.answer}`);

  assert(grounded.answer.includes("412"), "answer lost the figure from the sources");
  const used = citations(grounded.answer);
  assert(used.length > 0, "answer cited no source");
  assert(
    used.every((index) => index >= 1 && index <= grounded.used.length),
    `answer cited a source outside the prompt: ${JSON.stringify(used)}`,
  );
  assert(grounded.sources.length === grounded.used.length, "sources do not match the chunks sent");

  const headcount = await answerWithContext({
    question: "How did headcount change?",
    chunks: CHUNKS,
  });
  console.log(`\nheadcount:\n${headcount.answer}`);
  assert(headcount.answer.includes("40") && headcount.answer.includes("47"), "headcount answer lost its figures");
  assert(citations(headcount.answer).includes(2), "headcount answer cited the wrong passage");

  const deployment = await answerWithContext({
    question: "Which region hosts the service?",
    chunks: [{ ...CHUNKS[0], documentName: "deployment.md", headingPath: ["Deployment"], text: "The service runs in the eu-west-2 region. Backups are retained for 14 days." }],
  });
  console.log(`\ndeployment:\n${deployment.answer}`);
  assert(deployment.answer.includes("eu-west-2"), "answer lost the deployment region");
  assert(citations(deployment.answer).includes(1), "deployment answer cited no source");

  const unanswerable = await answerWithContext({
    question: "What is the CEO's name?",
    chunks: CHUNKS,
  });
  console.log(`\nunanswerable:\n${unanswerable.answer}`);
  assert(
    unanswerable.answer.startsWith("I couldn't find that"),
    "model answered a question the sources do not cover; refusal prompt needs work",
  );

  assert(unanswerable.sources.length === 0, "refusal should not carry source citations");

  const rewritten = await rewriteQuery([
    { role: "user", content: "What was the biggest cost driver?" },
    {
      role: "assistant",
      content: "Cloud compute was the biggest cost driver, at $412k [1].",
    },
    { role: "user", content: "How much did headcount grow?" },
  ]);
  console.log(`\nrewritten follow-up: ${rewritten}`);
  assert(rewritten.trim().length > 0, "query rewrite returned empty text");
  assert(rewritten.toLowerCase().includes("headcount"), "rewrite lost the latest question topic");
  assert((rewritten.toLowerCase().match(/headcount/g) ?? []).length <= 3, "rewrite repeated keywords");
  assert(rewritten.length <= 200, "query rewrite looks like rambling, not a search query");
  assert(!/^(assistant|user)\b/i.test(rewritten), "query rewrite echoed the transcript");

  console.log("\nok: local chat server answers, cites, refuses, and rewrites");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
