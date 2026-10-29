import { answerWithContext, decideResponse, rewriteQuery, type ChatTurn } from "./chat";
import type { RetrievalResult } from "./search";

/** Keep all document access inside the search branch. */
export async function respondToMessage(
  turns: ChatTurn[],
  search: (query: string) => Promise<RetrievalResult>,
) {
  const decision = await decideResponse(turns);
  if (decision.action === "answer") {
    return {
      answer: decision.answer,
      sources: [],
      mode: "direct" as const,
      query: null,
      rewrittenQuery: null,
      scanned: 0,
      keywordUsed: false,
    };
  }

  const query = await rewriteQuery(turns);
  const retrieval = await search(query);
  const question = [...turns].reverse().find((turn) => turn.role === "user")!.content.trim();
  const answer = await answerWithContext({ question, chunks: retrieval.chunks });
  return {
    answer: answer.answer,
    sources: answer.sources,
    mode: "documents" as const,
    query: retrieval.query,
    rewrittenQuery: query,
    scanned: retrieval.scanned,
    keywordUsed: retrieval.keywordUsed,
  };
}
