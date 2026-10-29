import { Binary, type Collection, type Db, type ObjectId } from "mongodb";
import { client } from "@/lib/mongo";

export const DOCUMENTS_COLLECTION = "rag_documents";
export const CHUNKS_COLLECTION = "rag_chunks";

export type RagDocumentStatus = "processing" | "ready" | "failed";

export type RagDocument = {
  _id?: ObjectId;
  userId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  status: RagDocumentStatus;
  pageCount: number;
  chunkCount: number;
  error?: string;
  embeddingModel: string;
  embeddingDimensions: number;
  chunkerVersion: string;
  createdAt: Date;
  updatedAt: Date;
};

export type RagChunk = {
  _id?: ObjectId;
  documentId: ObjectId;
  userId: string;
  chunkIndex: number;
  text: string;
  embedText: string;
  headingPath: string[];
  page: number | null;
  startChar: number;
  endChar: number;
  tokens: number;
  embedding: Binary;
  embeddingModel: string;
  embeddingDimensions: number;
  chunkerVersion: string;
  createdAt: Date;
};

export function ragDb(): Db {
  return client.db();
}

export function documentsCollection(): Collection<RagDocument> {
  return ragDb().collection<RagDocument>(DOCUMENTS_COLLECTION);
}

export function chunksCollection(): Collection<RagChunk> {
  return ragDb().collection<RagChunk>(CHUNKS_COLLECTION);
}

let indexPromise: Promise<void> | null = null;

/**
 * Create the indexes the pipeline relies on, once per process. The text index
 * powers keyword search/fusion; it is what makes hybrid retrieval work on a
 * plain MongoDB Community server.
 */
export function ensureRagIndexes(): Promise<void> {
  if (!indexPromise) {
    indexPromise = (async () => {
      await Promise.all([
        documentsCollection().createIndex({ userId: 1, createdAt: -1 }),
        documentsCollection().createIndex(
          { userId: 1, sha256: 1 },
          { name: "user_document_hash" },
        ),
        chunksCollection().createIndex(
          { documentId: 1, chunkIndex: 1 },
          { unique: true, name: "document_chunk_order" },
        ),
        chunksCollection().createIndex({ userId: 1, documentId: 1 }),
        chunksCollection().createIndex(
          { text: "text" },
          { name: "chunk_text", default_language: "english" },
        ),
      ]);
    })().catch((error) => {
      // Allow a later request to retry index creation.
      indexPromise = null;
      throw error;
    });
  }
  return indexPromise;
}

/**
 * Store embeddings as BSON BinData float32: half the disk of a double array,
 * and the format `$vectorSearch` accepts directly when we move to Atlas.
 */
export function encodeVector(vector: Float32Array): Binary {
  const copy = new Uint8Array(vector.byteLength);
  copy.set(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
  return new Binary(Buffer.from(copy), Binary.SUBTYPE_VECTOR);
}

export function decodeVector(value: Binary): Float32Array {
  // Copy into an aligned buffer: Float32Array requires a 4-byte offset.
  const source = value.buffer;
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return new Float32Array(copy.buffer);
}

/** Shape returned to the client. ObjectIds become strings, Dates stay Dates. */
export type DocumentSummary = {
  id: string;
  name: string;
  size: number;
  uploadedAt: number;
  status: RagDocumentStatus;
  pageCount: number;
  chunkCount: number;
  error?: string;
};

export function toDocumentSummary(document: RagDocument & { _id: ObjectId }): DocumentSummary {
  return {
    id: document._id.toString(),
    name: document.name,
    size: document.size,
    uploadedAt: document.createdAt.getTime(),
    status: document.status,
    pageCount: document.pageCount,
    chunkCount: document.chunkCount,
    ...(document.error ? { error: document.error } : {}),
  };
}
