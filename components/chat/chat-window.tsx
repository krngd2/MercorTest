"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Chat } from "@/lib/chat-data";
import { SendIcon } from "./icons";

type Props = {
  chat: Chat | undefined;
  onSend: (text: string) => void;
  busy?: boolean;
};

const suggestions = [
  "Summarise the documents I uploaded",
  "Draft a reply to a customer",
  "Explain this in simple terms",
];

export function ChatWindow({ chat, onSend, busy = false }: Props) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [chat?.id, chat?.messages.length]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!input.trim() || busy) return;
    onSend(input);
    setInput("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() && !busy) {
        onSend(input);
        setInput("");
      }
    }
  }

  if (!chat) {
    return (
      <section className="flex flex-1 items-center justify-center bg-white">
        <p className="text-sm text-gray-500">Select or create a chat to get started.</p>
      </section>
    );
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-white">
      <header className="flex items-center justify-between border-b border-gray-200 px-6 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-gray-900">{chat.title}</h1>
          <p className="text-xs text-gray-500">
            {chat.messages.length} message{chat.messages.length === 1 ? "" : "s"}
          </p>
        </div>
        <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200">
          {busy ? "Thinking…" : "Chat · documents when needed"}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          {chat.messages.length === 0 && (
            <div className="pt-10 text-center">
              <h2 className="text-lg font-semibold text-gray-900">How can I help?</h2>
              <p className="mt-1 text-sm text-gray-500">
                Ask a question, or pick one of these to start.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => onSend(s)}
                    className="rounded-full border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {chat.messages.map((message) => (
            <div
              key={message.id}
              className={`flex gap-3 ${
                message.role === "user" ? "flex-row-reverse" : "flex-row"
              }`}
            >
              <div
                className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                  message.role === "user"
                    ? "bg-gray-900 text-white"
                    : "bg-gray-100 text-gray-700 ring-1 ring-gray-200"
                }`}
              >
                {message.role === "user" ? "You" : "AI"}
              </div>

              <div className="flex max-w-[80%] flex-col gap-1.5">
                <div
                  className={`whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    message.role === "user"
                      ? "bg-gray-900 text-white"
                      : "bg-gray-100 text-gray-900"
                  }`}
                >
                  {message.content}
                </div>

                {message.role === "assistant" && message.sources?.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {message.sources.map((source) => (
                      <span
                        key={`${message.id}-${source.index}`}
                        title={
                          source.headingPath.length
                            ? source.headingPath.join(" > ")
                            : source.preview
                        }
                        className="rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px] text-gray-600"
                      >
                        [{source.index}] {source.documentName}
                        {source.page ? ` · p.${source.page}` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}

          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t border-gray-200 px-6 py-4">
        <form onSubmit={submit} className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Send a message…"
            className="max-h-40 min-h-11 flex-1 resize-none rounded-xl border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-30"
            aria-label="Send message"
          >
            <SendIcon className="h-4 w-4" />
          </button>
        </form>
        <p className="mx-auto mt-2 max-w-3xl text-[11px] text-gray-400">
          Enter to send · Shift + Enter for a new line
        </p>
      </div>
    </section>
  );
}
