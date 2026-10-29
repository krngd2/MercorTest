import type { ChatTurn } from "@/lib/rag/chat";
import { respondToMessage } from "@/lib/rag/pipeline";
import { retrieve } from "@/lib/rag/search";
import { currentUserId, errorResponse } from "@/lib/rag/session";

const MAX_TURNS = 30;

function parseTurns(value: unknown): ChatTurn[] | null {
  if (!Array.isArray(value)) return null;
  const turns: ChatTurn[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
      return null;
    }
    turns.push({ role, content });
  }
  return turns.slice(-MAX_TURNS);
}

export async function POST(request: Request) {
  let body: { messages?: unknown; documentIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Expected a JSON body.", 400);
  }

  const turns = parseTurns(body.messages);
  if (!turns?.length) {
    return errorResponse("`messages` must be a non-empty array of turns.", 400);
  }

  const question = [...turns].reverse().find((turn) => turn.role === "user")?.content.trim();
  if (!question) {
    return errorResponse("The last message must be a non-empty user message.", 400);
  }

  const documentIds = Array.isArray(body.documentIds)
    ? body.documentIds.filter((id): id is string => typeof id === "string")
    : undefined;

  try {
    const result = await respondToMessage(turns, async (query) => {
      const userId = await currentUserId();
      return retrieve({ userId, query, documentIds });
    });
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
