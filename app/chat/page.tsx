"use client";

import { useEffect, useMemo, useState } from "react";
import { ChatSidebar } from "@/components/chat/chat-sidebar";
import { ChatWindow } from "@/components/chat/chat-window";
import { DocumentsPanel } from "@/components/chat/documents-panel";
import {
  initialChats,
  initialDocuments,
  type Chat,
  type Message,
  type Source,
  type UploadedDocument,
} from "@/lib/chat-data";

type ApiDocument = {
  id: string;
  name: string;
  size: number;
  uploadedAt: number;
  status: UploadedDocument["status"];
  chunkCount: number;
  error?: string;
};

function toUploadedDocument(document: ApiDocument): UploadedDocument {
  return {
    id: document.id,
    name: document.name,
    size: document.size,
    uploadedAt: document.uploadedAt,
    status: document.status,
    chunkCount: document.chunkCount,
    error: document.error,
  };
}

export default function ChatPage() {
  const [chats, setChats] = useState<Chat[]>(initialChats);
  const [activeId, setActiveId] = useState(initialChats[0]?.id ?? "");
  const [documents, setDocuments] = useState<UploadedDocument[]>(initialDocuments);
  const [busy, setBusy] = useState(false);

  const orderedChats = useMemo(
    () => [...chats].sort((a, b) => b.updatedAt - a.updatedAt),
    [chats],
  );
  const activeChat = chats.find((chat) => chat.id === activeId);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/documents")
      .then((response) => response.json())
      .then((data: { documents?: ApiDocument[] }) => {
        if (cancelled || !data.documents) return;
        setDocuments(data.documents.map(toUploadedDocument));
      })
      .catch(() => {
        // The panel still works for uploads; errors surface per file.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function createChat() {
    const id = crypto.randomUUID();
    setChats((prev) => [
      { id, title: "New chat", updatedAt: Date.now(), messages: [] },
      ...prev,
    ]);
    setActiveId(id);
  }

  function deleteChat(id: string) {
    const next = chats.filter((chat) => chat.id !== id);
    setChats(next);
    if (id === activeId) {
      setActiveId(next[0]?.id ?? "");
    }
  }

  function patchMessage(chatId: string, messageId: string, patch: Partial<Message>) {
    setChats((prev) =>
      prev.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              updatedAt: Date.now(),
              messages: chat.messages.map((message) =>
                message.id === messageId ? { ...message, ...patch } : message,
              ),
            }
          : chat,
      ),
    );
  }

  async function sendMessage(text: string) {
    const content = text.trim();
    if (!content || busy) return;

    let chatId = activeId;

    // If no chat is selected yet, start one on the fly.
    if (!chatId) {
      chatId = crypto.randomUUID();
      setChats((prev) => [
        { id: chatId, title: content.slice(0, 40), updatedAt: Date.now(), messages: [] },
        ...prev,
      ]);
      setActiveId(chatId);
    }

    const existing = chats.find((chat) => chat.id === chatId);
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content,
    };
    const placeholder: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "Thinking…",
    };

    setChats((prev) =>
      prev.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              // First message becomes the chat title.
              title: chat.messages.length === 0 ? content.slice(0, 40) : chat.title,
              updatedAt: Date.now(),
              messages: [...chat.messages, userMessage, placeholder],
            }
          : chat,
      ),
    );

    setBusy(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...(existing?.messages ?? []), userMessage].map(
            ({ role, content: messageContent }) => ({
              role,
              content: messageContent,
            }),
          ),
          documentIds: documents
            .filter((document) => document.status !== "failed")
            .map((document) => document.id),
        }),
      });

      const data = (await response.json()) as {
        answer?: string;
        sources?: Source[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "The assistant could not answer.");
      }

      patchMessage(chatId, placeholder.id, {
        content: data.answer ?? "The assistant returned an empty response.",
        sources: data.sources ?? [],
      });
    } catch (error) {
      patchMessage(chatId, placeholder.id, {
        content:
          error instanceof Error
            ? `Something went wrong: ${error.message}`
            : "Something went wrong.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function addDocuments(files: FileList) {
    for (const file of Array.from(files)) {
      const body = new FormData();
      body.append("file", file);

      try {
        const response = await fetch("/api/documents", { method: "POST", body });
        const data = (await response.json()) as {
          document?: ApiDocument;
          error?: string;
        };

        if (!response.ok || !data.document) {
          throw new Error(data.error ?? "Upload failed.");
        }

        const uploaded = toUploadedDocument(data.document);
        setDocuments((prev) => [
          uploaded,
          ...prev.filter((document) => document.id !== uploaded.id),
        ]);
      } catch (error) {
        setDocuments((prev) => [
          {
            id: crypto.randomUUID(),
            name: file.name,
            size: file.size,
            uploadedAt: Date.now(),
            status: "failed",
            error: error instanceof Error ? error.message : "Upload failed.",
          },
          ...prev,
        ]);
      }
    }
  }

  async function removeDocument(id: string) {
    const response = await fetch(`/api/documents/${id}`, { method: "DELETE" });
    if (response.ok || response.status === 404) {
      setDocuments((prev) => prev.filter((document) => document.id !== id));
    }
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-white text-gray-900">
      <ChatSidebar
        chats={orderedChats}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={createChat}
        onDelete={deleteChat}
      />
      <ChatWindow chat={activeChat} onSend={sendMessage} busy={busy} />
      <DocumentsPanel
        documents={documents}
        onUpload={addDocuments}
        onRemove={removeDocument}
      />
    </div>
  );
}
