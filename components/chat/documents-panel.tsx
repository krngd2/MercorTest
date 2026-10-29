"use client";

import { useRef, type ChangeEvent } from "react";
import { formatBytes, formatDate, type UploadedDocument } from "@/lib/chat-data";
import { FileIcon, PaperclipIcon, TrashIcon } from "./icons";

type Props = {
  documents: UploadedDocument[];
  onUpload: (files: FileList) => void;
  onRemove: (id: string) => void;
};

export function DocumentsPanel({ documents, onUpload, onRemove }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) {
      onUpload(e.target.files);
    }
    e.target.value = "";
  }

  return (
    <aside className="hidden w-72 shrink-0 flex-col border-l border-gray-200 bg-gray-50 lg:flex">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <span className="text-sm font-semibold">Documents</span>
        <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-700">
          {documents.length}
        </span>
      </div>

      <div className="p-3">
        <input
          ref={inputRef}
          type="file"
          multiple
          onChange={handleChange}
          className="hidden"
        />
        <button
          onClick={() => inputRef.current?.click()}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-gray-300 bg-white px-3 py-3 text-sm font-medium text-gray-700 hover:border-gray-400 hover:bg-gray-100"
        >
          <PaperclipIcon className="h-4 w-4" />
          Upload document
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {documents.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-300 px-3 py-8 text-center">
            <FileIcon className="mx-auto h-6 w-6 text-gray-400" />
            <p className="mt-2 text-xs text-gray-500">
              No documents yet. Upload one to give the assistant context.
            </p>
          </div>
        )}

        {documents.map((doc) => (
          <div
            key={doc.id}
            className="group flex items-start gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2.5"
          >
            <FileIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-gray-900" title={doc.name}>
                {doc.name}
              </p>
              <p className="text-[11px] text-gray-500">
                {formatBytes(doc.size)} · {formatDate(doc.uploadedAt)}
                {doc.status === "failed"
                  ? " · failed"
                  : doc.chunkCount
                    ? ` · ${doc.chunkCount} chunks`
                    : ""}
              </p>
              {doc.error ? (
                <p className="mt-1 text-[11px] leading-snug text-red-600">
                  {doc.error}
                </p>
              ) : null}
            </div>
            <button
              onClick={() => onRemove(doc.id)}
              title="Remove document"
              className="rounded p-1 text-gray-400 opacity-0 hover:bg-gray-100 hover:text-red-600 group-hover:opacity-100"
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      <p className="border-t border-gray-200 px-4 py-3 text-[11px] leading-relaxed text-gray-500">
        Files are held in memory for this demo — nothing is uploaded to a server or
        stored in MongoDB yet.
      </p>
    </aside>
  );
}
