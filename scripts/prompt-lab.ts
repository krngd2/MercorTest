/**
 * Throwaway experiment. Not part of the app.
 * Which source header yields clean prose instead of an echoed label?
 */
import type { RetrievedChunk } from "../lib/rag/search";

const URL = "http://127.0.0.1:8098/v1/chat/completions";

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

const HEADERS: Record<string, (chunk: RetrievedChunk, index: number) => string> = {
  "full label": (chunk, index) =>
    `[${index}] ${chunk.documentName} — page ${chunk.page} — ${chunk.headingPath.join(" > ")}`,
  "name + page": (chunk, index) => `[${index}] ${chunk.documentName} — page ${chunk.page}`,
  "name only": (chunk, index) => `[${index}] ${chunk.documentName}`,
  "metadata line": (chunk, index) =>
    `[${index}] ${chunk.documentName} (page ${chunk.page}, ${chunk.headingPath.join(" > ")})`,
};

const TAIL =
  "Answer in one or two sentences using only the sources. End with the source number in brackets, like [1].";

async function ask(context: string, question: string): Promise<string> {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: "Answer using only the sources. Cite with [n]." },
        { role: "user", content: `Sources:\n\n${context}\n\nQuestion: ${question}\n\n${TAIL}` },
      ],
      temperature: 0,
      max_tokens: 512,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content?.trim() ?? "<empty>";
}

const QUESTIONS = ["What was the biggest cost driver?", "How did headcount change?"];

async function main() {
  for (const [name, header] of Object.entries(HEADERS)) {
    const context = CHUNKS.map((chunk, index) => `${header(chunk, index + 1)}\n${chunk.text}`).join(
      "\n\n---\n\n",
    );
    console.log(`\n=== ${name} ===`);
    for (const question of QUESTIONS) {
      console.log(`  Q: ${question}`);
      console.log(`  A: ${await ask(context, question)}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
