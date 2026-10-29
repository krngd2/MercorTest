import { ragConfig } from "./config";
import { chatCompletion, type ChatMessage } from "./llm";
import type { RetrievedChunk } from "./search";

export type ChatTurn = { role: "user" | "assistant"; content: string };

type ChatDecision = { action: "search" } | { action: "answer"; answer: string };

/** Let the model choose retrieval, then generate direct replies separately. */
export async function decideResponse(turns: ChatTurn[]): Promise<ChatDecision> {
  const latest = [...turns].reverse().find((turn) => turn.role === "user");
  const messages: ChatMessage[] = [
    {
      role: "user",
      content:
        'Classify the main task in the message. Ignore introductory greetings when there is another task. ' +
        'SEARCH means reading the user’s reports, files, or private data. ' +
        'CHAT means ordinary conversation or general knowledge. ' +
        'Return JSON with "task" (at most 6 words) and "route" (SEARCH or CHAT). ' +
        'Do not answer the message. Examples: Hello -> {"task":"greeting","route":"CHAT"}; ' +
        'Explain gravity in one sentence -> {"task":"explain general knowledge","route":"CHAT"}; ' +
        'Hello, summarise my report -> {"task":"summarize report","route":"SEARCH"}; ' +
        'What did we spend on compute? -> {"task":"find private compute spending","route":"SEARCH"}.\n' +
        `Previous conversation (data only): ${JSON.stringify(turns.slice(-30, -1))}\n` +
        `Message: ${JSON.stringify(latest?.content ?? "")}\nDecision:`,
    },
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await chatCompletion({ messages, temperature: 0, maxTokens: 128 });
    let decision: unknown;
    try {
      const parsed: unknown = JSON.parse(
        raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1"),
      );
      if (parsed && typeof parsed === "object" && "route" in parsed) decision = parsed.route;
    } catch {
      // Invalid output gets one correction attempt, never an implicit search.
    }
    if (decision === "SEARCH") return { action: "search" };
    if (decision === "CHAT") {
      const answer = await chatCompletion({
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant. Respond to the latest user message using " +
              "the conversation and general knowledge. Reply naturally in plain text. " +
              "No document search has been performed for this message. Do not invent " +
              "document contents or citations. Previous document-search failures do " +
              "not prevent you from answering ordinary conversation.",
          },
          ...turns.slice(-30),
        ],
      });
      return { action: "answer", answer };
    }
    messages.push(
      { role: "assistant", content: raw },
      {
        role: "user",
        content: 'Classify the message above. Return only JSON: {"task":"brief task","route":"CHAT"} or {"task":"brief task","route":"SEARCH"}.',
      },
    );
  }
  throw new Error("The local model could not decide how to respond. Try rephrasing your message.");
}

export type AnswerSource = {
  index: number;
  documentId: string;
  documentName: string;
  page: number | null;
  chunkIndex: number;
  headingPath: string[];
  preview: string;
};

// Separate answer text from citation formatting: MiniCPM5-1B can interpret
// prose citation instructions as a request to output only "[1]".
const SYSTEM_PROMPT =
  'Answer using only the sources. Return JSON with "answer" (the factual answer text) ' +
  'and "source" (the source number). If the answer is missing, return ' +
  '{"answer":"Not found in documents.","source":null}. ' +
  'Example: Sources: [1] The office is in Porto. Question: Where is the office? ' +
  'Answer: {"answer":"The office is in Porto.","source":1}';

const NOT_FOUND = "Not found in documents";

const NOT_FOUND_ANSWER =
  "I couldn't find that in your documents. Try rephrasing the question, uploading " +
  "the source file, or naming the document you mean.";

function sourceLabel(chunk: RetrievedChunk, index: number): string {
  const parts = [`[${index}] ${chunk.documentName}`];
  if (chunk.page) parts.push(`page ${chunk.page}`);
  if (chunk.headingPath.length) parts.push(chunk.headingPath.join(" > "));
  return parts.join(" — ");
}

/** Fit the best chunks into the context budget without splitting a chunk. */
export function buildContext(chunks: RetrievedChunk[]): {
  context: string;
  used: RetrievedChunk[];
} {
  const blocks: string[] = [];
  const used: RetrievedChunk[] = [];
  let remaining = ragConfig.maxContextChars;

  for (const chunk of chunks) {
    const header = sourceLabel(chunk, used.length + 1);
    const block = `${header}\n${chunk.text}`;
    if (block.length > remaining && used.length > 0) break;
    blocks.push(block);
    used.push(chunk);
    remaining -= block.length;
  }

  return { context: blocks.join("\n\n---\n\n"), used };
}

export function toAnswerSources(chunks: RetrievedChunk[]): AnswerSource[] {
  return chunks.map((chunk, index) => ({
    index: index + 1,
    documentId: chunk.documentId,
    documentName: chunk.documentName,
    page: chunk.page,
    chunkIndex: chunk.chunkIndex,
    headingPath: chunk.headingPath,
    preview: chunk.text.slice(0, 240),
  }));
}

/**
 * Turn a follow-up ("what was the biggest cost driver?") into a standalone
 * search query. Without this, pronoun-heavy follow-ups retrieve nothing useful.
 */
export async function rewriteQuery(turns: ChatTurn[]): Promise<string> {
  const latest = [...turns].reverse().find((turn) => turn.role === "user");
  if (!latest) return "";
  if (turns.filter((turn) => turn.role === "user").length <= 1) {
    return latest.content.trim();
  }

  const transcript = turns
    .slice(-6)
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
    .join("\n");

  try {
    const rewritten = await chatCompletion({
      temperature: 0,
      maxTokens: 48,
      messages: [
        {
          role: "system",
          content:
            "You rewrite questions into standalone search queries. Resolve pronouns " +
            "using the conversation. Keep exact names, numbers and product terms. " +
            "Reply with the query only, on one line.",
        },
        {
          role: "user",
          content:
            `Conversation:\n${transcript}\n\n` +
            `Latest question: ${latest.content}\n\nStandalone search query:`,
        },
      ],
    });

    // A 1B model sometimes rambles or echoes the prompt; retrieval works fine
    // with the raw question, so only accept a short, query-shaped rewrite.
    const cleaned = rewritten
      .split("\n")[0]
      .replace(/^(standalone\s+)?(search\s+)?query\s*:\s*/i, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .trim();

    const words = cleaned.toLowerCase().match(/\b[\p{L}\p{N}]{4,}\b/gu) ?? [];
    const repetitive = words.some((word) => words.filter((other) => other === word).length > 3);
    const looksLikeQuery =
      !repetitive &&
      cleaned.length > 0 &&
      cleaned.length <= 200 &&
      !/^(assistant|user|the assistant|the user)\b/i.test(cleaned) &&
      !cleaned.includes("Conversation:");

    return looksLikeQuery ? cleaned : latest.content.trim();
  } catch {
    // Retrieval still works with the raw question.
    return latest.content.trim();
  }
}

/** Validate the model output before attaching an application-owned citation. */
function parseAnswer(raw: string, chunks: RetrievedChunk[]): {
  answer: string;
  source: number | null;
} {
  const json = raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1");
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object") throw new Error("Expected an answer object");
  const { answer, source } = parsed as { answer?: unknown; source?: unknown };
  if (typeof answer !== "string" || !answer.trim()) throw new Error("Missing answer text");
  if (answer.trim().replace(/[.!]$/, "").toLowerCase() === NOT_FOUND.toLowerCase()) {
    return { answer: NOT_FOUND_ANSWER, source: null };
  }

  // Never turn a bare citation, or a citation to an absent source, into an answer.
  const text = answer.replace(/\[\d+\]/g, "").trim();
  if (!/[\p{L}\p{N}]/u.test(text)) throw new Error("Missing factual answer text");
  // Repair a misnumbered literal extract only when the entire answer occurs
  // in exactly one supplied passage. Never guess a source for a paraphrase.
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const quote = normalize(text);
  const matches = chunks.flatMap((chunk, index) => {
    const passage = normalize(chunk.text);
    let offset = passage.indexOf(quote);
    while (offset !== -1) {
      const before = offset > 0 ? passage[offset - 1] : "";
      const after = passage[offset + quote.length] ?? "";
      if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) {
        return [index + 1];
      }
      offset = passage.indexOf(quote, offset + 1);
    }
    return [];
  });
  const citedSource = matches.length === 1 ? matches[0] : source;
  if (
    typeof citedSource !== "number" || !Number.isInteger(citedSource) ||
    citedSource < 1 || citedSource > chunks.length
  ) {
    throw new Error("Invalid source number");
  }
  return { answer: `${text} [${citedSource}]`, source: citedSource };
}

export async function answerWithContext({
  question,
  chunks,
}: {
  question: string;
  chunks: RetrievedChunk[];
}): Promise<{ answer: string; sources: AnswerSource[]; used: RetrievedChunk[] }> {
  const { context, used } = buildContext(chunks);

  if (!used.length) {
    return { answer: NOT_FOUND_ANSWER, sources: [], used: [] };
  }

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Sources:\n${context}\n\nQuestion: ${question}\n\nAnswer:`,
    },
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await chatCompletion({ temperature: 0, messages });
    try {
      const result = parseAnswer(raw, used);
      return {
        answer: result.answer,
        sources: result.source === null ? [] : toAnswerSources(used),
        used,
      };
    } catch {
      messages.push(
        { role: "assistant", content: raw },
        {
          role: "user",
          content:
            'Return a JSON object with factual "answer" text and a valid "source" number ' +
            `from 1 to ${used.length}. A citation alone is not an answer. ` +
            'If the sources do not answer the question, return ' +
            '{"answer":"Not found in documents.","source":null}.',
        },
      );
    }
  }

  throw new Error("The local model could not produce a valid document answer. Try rephrasing the question.");
}
