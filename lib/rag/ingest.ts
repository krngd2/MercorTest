import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { chunkDocument } from "./chunk";
import { ragConfig } from "./config";
import { embedTexts } from "./embed";
import { assertFileSize, assertParsable, parseDocument } from "./parse";
import {
  chunksCollection,
  documentsCollection,
  encodeVector,
  ensureRagIndexes,
  toDocumentSummary,
  type DocumentSummary,
  type RagChunk,
  type RagDocument,
} from "./store";

function insertBatches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function listDocuments(userId: string): Promise<DocumentSummary[]> {
  await ensureRagIndexes();
  const documents = await documentsCollection()
    .find({ userId })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();

  return documents.map((document) =>
    toDocumentSummary(document as RagDocument & { _id: ObjectId }),
  );
}

export async function deleteDocument(userId: string, id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const documentId = new ObjectId(id);

  const result = await documentsCollection().deleteOne({ _id: documentId, userId });
  if (!result.deletedCount) return false;

  await chunksCollection().deleteMany({ documentId, userId });
  return true;
}

/**
 * Parse → chunk → embed → store, idempotently.
 *
 * The same file (same sha256) uploaded twice by the same user reuses the
 * existing document instead of paying for embeddings twice.
 */
export async function ingestFile({
  userId,
  file,
}: {
  userId: string;
  file: File;
}): Promise<DocumentSummary> {
  assertFileSize(file.size);
  assertParsable(file.name, file.type);
  await ensureRagIndexes();

  const buffer = await file.arrayBuffer();
  const sha256 = createHash("sha256").update(Buffer.from(buffer)).digest("hex");
  const mime = file.type || "application/octet-stream";

  const existing = await documentsCollection().findOne({
    userId,
    sha256,
    status: "ready",
    embeddingModel: ragConfig.embeddingModel,
    embeddingDimensions: ragConfig.embeddingDimensions,
    chunkerVersion: ragConfig.chunkerVersion,
  });

  if (existing) {
    return toDocumentSummary(existing as RagDocument & { _id: ObjectId });
  }

  const now = new Date();
  const document: RagDocument = {
    userId,
    name: file.name,
    mime,
    size: file.size,
    sha256,
    status: "processing",
    pageCount: 0,
    chunkCount: 0,
    embeddingModel: ragConfig.embeddingModel,
    embeddingDimensions: ragConfig.embeddingDimensions,
    chunkerVersion: ragConfig.chunkerVersion,
    createdAt: now,
    updatedAt: now,
  };

  const { insertedId } = await documentsCollection().insertOne(document);

  try {
    const parsed = await parseDocument(file);
    const chunks = chunkDocument({ title: file.name, pages: parsed.pages });

    if (!chunks.length) {
      throw new Error(
        "No extractable text found. If this is a scanned PDF, run OCR before uploading.",
      );
    }

    const vectors = await embedTexts(chunks.map((chunk) => chunk.embedText));

    // Re-uploading the same name after a failure should not leave orphans.
    await chunksCollection().deleteMany({ documentId: insertedId, userId });

    const rows: RagChunk[] = chunks.map((chunk, index) => ({
      documentId: insertedId,
      userId,
      chunkIndex: chunk.index,
      text: chunk.text,
      embedText: chunk.embedText,
      headingPath: chunk.headingPath,
      page: chunk.page,
      startChar: chunk.startChar,
      endChar: chunk.endChar,
      tokens: chunk.tokens,
      embedding: encodeVector(vectors[index]),
      embeddingModel: ragConfig.embeddingModel,
      embeddingDimensions: ragConfig.embeddingDimensions,
      chunkerVersion: ragConfig.chunkerVersion,
      createdAt: now,
    }));

    for (const batch of insertBatches(rows, 500)) {
      await chunksCollection().insertMany(batch, { ordered: false });
    }

    await documentsCollection().updateOne(
      { _id: insertedId },
      {
        $set: {
          status: "ready" satisfies RagDocument["status"],
          pageCount: parsed.pageCount,
          chunkCount: rows.length,
          updatedAt: new Date(),
        },
        $unset: { error: "" },
      },
    );

    return toDocumentSummary({
      ...document,
      _id: insertedId,
      status: "ready",
      pageCount: parsed.pageCount,
      chunkCount: rows.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ingestion failed";
    await Promise.allSettled([
      documentsCollection().updateOne(
        { _id: insertedId },
        {
          $set: {
            status: "failed" satisfies RagDocument["status"],
            error: message.slice(0, 500),
            updatedAt: new Date(),
          },
        },
      ),
      chunksCollection().deleteMany({ documentId: insertedId, userId }),
    ]);
    throw error;
  }
}
