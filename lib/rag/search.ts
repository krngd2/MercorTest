import { ObjectId, type Filter } from "mongodb";
import { ragConfig } from "./config";
import { embedQuery } from "./embed";
import {
  chunksCollection,
  decodeVector,
  documentsCollection,
  type RagChunk,
} from "./store";

export type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  documentName: string;
  text: string;
  headingPath: string[];
  page: number | null;
  chunkIndex: number;
  score: number;
  matchedBy: ("vector" | "keyword")[];
};

export type RetrievalResult = {
  chunks: RetrievedChunk[];
  scanned: number;
  keywordUsed: boolean;
  query: string;
};

const RRF_K = 60;

function parseIds(documentIds?: string[]): ObjectId[] {
  if (!documentIds?.length) return [];
  return documentIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
}

/**
 * Exact kNN over one user's chunks. This is the local-MongoDB path: no
 * `$vectorSearch`, no separate service. Fine up to ~20k chunks, at which point
 * the same function should be swapped for an Atlas implementation.
 */
async function vectorSearch(
  scope: Filter<RagChunk>,
  query: string,
): Promise<{ ids: string[]; scanned: number }> {
  const collection = chunksCollection();

  const scanned = await collection.countDocuments(scope);
  if (scanned > ragConfig.maxScanChunks) {
    throw new Error(
      `Exact search would scan ${scanned.toLocaleString()} chunks, above the ` +
        `${ragConfig.maxScanChunks.toLocaleString()} limit. Filter by document ` +
        `or move this collection to Atlas Vector Search.`,
    );
  }

  if (scanned === 0) return { ids: [], scanned };

  const queryVector = await embedQuery(query);
  const scored: { id: string; score: number }[] = [];

  const cursor = collection.find(scope, { projection: { _id: 1, embedding: 1 } });
  for await (const row of cursor) {
    const vector = decodeVector(row.embedding);
    const length = Math.min(vector.length, queryVector.length);
    let dot = 0;
    for (let i = 0; i < length; i += 1) dot += vector[i] * queryVector[i];
    scored.push({ id: row._id.toString(), score: dot });
  }

  scored.sort((a, b) => b.score - a.score);
  return {
    ids: scored.slice(0, ragConfig.vectorCandidates).map((entry) => entry.id),
    scanned,
  };
}

/**
 * Keyword half of hybrid retrieval, backed by the collection's text index.
 * Missing index or an unsupported query degrades to vector-only.
 */
async function keywordSearch(
  scope: Filter<RagChunk>,
  query: string,
): Promise<{ ids: string[]; used: boolean }> {
  try {
    const rows = await chunksCollection()
      .aggregate<{ _id: ObjectId }>([
        { $match: { ...scope, $text: { $search: query } } },
        { $addFields: { textScore: { $meta: "textScore" } } },
        { $sort: { textScore: -1 } },
        { $limit: ragConfig.keywordCandidates },
        { $project: { _id: 1 } },
      ])
      .toArray();

    return { ids: rows.map((row) => row._id.toString()), used: true };
  } catch {
    return { ids: [], used: false };
  }
}

function fuse(
  vectorIds: string[],
  keywordIds: string[],
): { id: string; score: number; matchedBy: ("vector" | "keyword")[] }[] {
  const fused = new Map<
    string,
    { score: number; matchedBy: ("vector" | "keyword")[] }
  >();

  const add = (id: string, score: number, source: "vector" | "keyword") => {
    const entry = fused.get(id) ?? { score: 0, matchedBy: [] };
    entry.score += score;
    if (!entry.matchedBy.includes(source)) entry.matchedBy.push(source);
    fused.set(id, entry);
  };

  // Reciprocal Rank Fusion: scale-free, so cosine and textScore never compete.
  vectorIds.forEach((id, index) => add(id, 1 / (RRF_K + index + 1), "vector"));
  keywordIds.forEach((id, index) => add(id, 1 / (RRF_K + index + 1), "keyword"));

  return [...fused.entries()]
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => b.score - a.score);
}

export async function retrieve({
  userId,
  query,
  documentIds,
  limit,
}: {
  userId: string;
  query: string;
  documentIds?: string[];
  limit?: number;
}): Promise<RetrievalResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { chunks: [], scanned: 0, keywordUsed: false, query: trimmed };
  }

  const scopedIds = parseIds(documentIds);
  const scope: Filter<RagChunk> = scopedIds.length
    ? { userId, documentId: { $in: scopedIds } }
    : { userId };

  const [vector, keyword] = await Promise.all([
    vectorSearch(scope, trimmed),
    keywordSearch(scope, trimmed),
  ]);

  if (!vector.ids.length && !keyword.ids.length) {
    return {
      chunks: [],
      scanned: vector.scanned,
      keywordUsed: keyword.used,
      query: trimmed,
    };
  }

  const ranked = fuse(vector.ids, keyword.ids).slice(
    0,
    limit ?? ragConfig.finalK,
  );

  const rows = await chunksCollection()
    .find({ _id: { $in: ranked.map((entry) => new ObjectId(entry.id)) } })
    .toArray();

  const byId = new Map(rows.map((row) => [row._id!.toString(), row]));

  const documentIdsInResults = [
    ...new Set(rows.map((row) => row.documentId.toString())),
  ].map((id) => new ObjectId(id));

  const documents = await documentsCollection()
    .find(
      { _id: { $in: documentIdsInResults }, userId },
      { projection: { name: 1 } },
    )
    .toArray();

  const nameById = new Map(documents.map((doc) => [doc._id!.toString(), doc.name]));

  const chunks: RetrievedChunk[] = [];
  for (const entry of ranked) {
    const row = byId.get(entry.id);
    if (!row) continue;
    chunks.push({
      chunkId: entry.id,
      documentId: row.documentId.toString(),
      documentName: nameById.get(row.documentId.toString()) ?? "Unknown document",
      text: row.text,
      headingPath: row.headingPath,
      page: row.page,
      chunkIndex: row.chunkIndex,
      score: entry.score,
      matchedBy: entry.matchedBy,
    });
  }

  return {
    chunks,
    scanned: vector.scanned,
    keywordUsed: keyword.used,
    query: trimmed,
  };
}
