import { ragConfig } from "./config";
import { withRetry } from "./http";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatResponse = {
  choices?: { message?: { content?: string } }[];
};

/**
 * One chat completion from the local MiniCPM5 server (`npm run chat:serve`).
 * The server speaks the OpenAI wire format, so swapping in another local
 * runtime means pointing `RAG_LOCAL_CHAT_URL` at it.
 */
export async function chatCompletion({
  messages,
  temperature = 0.2,
  maxTokens = 1024,
}: {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  const { chatModel, localChatUrl, localChatTimeoutMs } = ragConfig;

  return withRetry(async () => {
    let response: Response;
    try {
      response = await fetch(localChatUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(chatModel ? { model: chatModel } : {}),
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: false,
          // MiniCPM5 is a hybrid-reasoning model; answers here are extractive,
          // so the fast non-thinking path is the right one.
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(localChatTimeoutMs),
      });
    } catch (error) {
      throw new Error(
        `Cannot reach the local chat server at ${localChatUrl}. ` +
          `Start it with \`npm run chat:serve\`. (${(error as Error).message})`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = new Error(
        `Local chat request failed: ${response.status} ${response.statusText}` +
          (body ? ` — ${body.slice(0, 500)}` : ""),
      ) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }

    const json = (await response.json()) as ChatResponse;
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Local chat server returned an empty response");
    }
    return content.trim();
  });
}
