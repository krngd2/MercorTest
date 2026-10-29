export type Role = "user" | "assistant";

export type Source = {
  index: number;
  documentId: string;
  documentName: string;
  page: number | null;
  chunkIndex: number;
  headingPath: string[];
  preview: string;
};

export type Message = {
  id: string;
  role: Role;
  content: string;
  sources?: Source[];
};

export type Chat = {
  id: string;
  title: string;
  updatedAt: number;
  messages: Message[];
};

export type UploadedDocument = {
  id: string;
  name: string;
  size: number;
  uploadedAt: number;
  status?: "processing" | "ready" | "failed";
  chunkCount?: number;
  error?: string;
};

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Deterministic (UTC) so server and client render identical markup.
export function formatDate(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export const initialChats: Chat[] = [
  {
    id: "chat-1",
    title: "New chat",
    updatedAt: Date.UTC(2026, 9, 29, 9, 0, 0),
    messages: [],
  },
];

export const initialDocuments: UploadedDocument[] = [];
