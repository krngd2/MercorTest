"use client";

import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import type { Chat } from "@/lib/chat-data";
import { ChatIcon, PlusIcon, TrashIcon } from "./icons";

type Props = {
  chats: Chat[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
};

export function ChatSidebar({ chats, activeId, onSelect, onNew, onDelete }: Props) {
  const { data: session } = authClient.useSession();

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-gray-200 bg-gray-50 md:flex">
      <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3">
        <ChatIcon className="h-5 w-5 text-gray-700" />
        <span className="text-sm font-semibold">Chats</span>
      </div>

      <div className="p-3">
        <button
          onClick={onNew}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-100"
        >
          <PlusIcon className="h-4 w-4" />
          New chat
        </button>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        {chats.length === 0 && (
          <p className="px-2 py-4 text-xs text-gray-500">No chats yet.</p>
        )}

        {chats.map((chat) => {
          const active = chat.id === activeId;
          const last = chat.messages.at(-1)?.content ?? "No messages yet";

          return (
            <div
              key={chat.id}
              className={`group flex items-start gap-1 rounded-lg px-2 py-2 ${
                active ? "bg-white shadow-sm ring-1 ring-gray-200" : "hover:bg-gray-100"
              }`}
            >
              <button
                onClick={() => onSelect(chat.id)}
                className="min-w-0 flex-1 text-left"
              >
                <p className="truncate text-sm font-medium text-gray-900">{chat.title}</p>
                <p className="truncate text-xs text-gray-500">{last}</p>
              </button>

              <button
                onClick={() => onDelete(chat.id)}
                title="Delete chat"
                className="mt-0.5 rounded p-1 text-gray-400 opacity-0 hover:bg-gray-200 hover:text-red-600 group-hover:opacity-100"
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-gray-200 px-4 py-3">
        {session ? (
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-gray-900">
              {session.user.name}
            </p>
            <p className="truncate text-xs text-gray-500">{session.user.email}</p>
          </div>
        ) : (
          <Link href="/" className="text-xs text-blue-600 underline">
            Sign in
          </Link>
        )}
      </div>
    </aside>
  );
}
