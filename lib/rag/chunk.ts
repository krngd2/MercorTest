import { ragConfig } from "./config";

export type DocumentChunk = {
  index: number;
  /** Raw chunk text, used for prompting and citations. */
  text: string;
  /** Text that was actually embedded: breadcrumb + text. */
  embedText: string;
  headingPath: string[];
  page: number | null;
  startChar: number;
  endChar: number;
  tokens: number;
};

export type PageInput = {
  text: string;
  page: number | null;
};

type Block = {
  text: string;
  headingPath: string[];
  page: number | null;
  startChar: number;
  endChar: number;
};

const HEADING = /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/;

/** Cheap heuristic. Good enough for budgeting; not a tokenizer. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

function buildEmbedText(title: string, headingPath: string[], text: string): string {
  const breadcrumb = dedupe([title, ...headingPath]).join(" > ");
  return breadcrumb ? `${breadcrumb}\n\n${text}` : text;
}

/** Collapse runs of whitespace but keep paragraph boundaries. */
function normalizeBlock(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split a page into paragraphs, tracking the heading stack and character
 * offsets so citations can point back at the source.
 */
function blocksFromPage({ text, page }: PageInput): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];

  let headings: string[] = [];
  let buffer: string[] = [];
  let bufferStart = -1;
  let bufferEnd = -1;
  let pendingHeading: string | null = null;
  let cursor = 0;

  function flush() {
    if (!buffer.length) {
      bufferStart = -1;
      return;
    }
    const body = normalizeBlock(buffer.join("\n"));
    if (body) {
      // Keep the heading in the chunk text so the answer is readable on its own.
      const text = pendingHeading ? `${pendingHeading}\n\n${body}` : body;
      blocks.push({
        text,
        headingPath: headings.filter(Boolean),
        page,
        startChar: bufferStart,
        endChar: bufferEnd,
      });
    }
    pendingHeading = null;
    buffer = [];
    bufferStart = -1;
  }

  for (const line of lines) {
    const lineStart = cursor;
    const lineEnd = cursor + line.length;
    cursor = lineEnd + 1;

    const heading = line.match(HEADING);
    if (heading) {
      flush();
      const level = heading[1].length;
      headings = headings.slice(0, level - 1);
      headings[level - 1] = heading[2].trim();
      pendingHeading = heading[2].trim();
      bufferStart = lineStart;
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    if (bufferStart < 0) bufferStart = lineStart;
    buffer.push(line);
    bufferEnd = lineEnd;
  }

  flush();
  return blocks;
}

function hardWrap(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(" ", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** Split an oversized paragraph on sentence boundaries, then hard-wrap. */
function splitOversized(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const sentences = text.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
    } else if (current.length + 1 + sentence.length <= maxChars) {
      current += ` ${sentence}`;
    } else {
      out.push(current);
      current = sentence;
    }
  }
  if (current) out.push(current);

  return out.flatMap((piece) =>
    piece.length > maxChars ? hardWrap(piece, maxChars) : [piece],
  );
}

function tailForOverlap(text: string, overlapChars: number): string {
  if (overlapChars <= 0 || text.length <= overlapChars) return text;
  const tail = text.slice(-overlapChars);
  // Start the overlap at a word boundary so it does not begin mid-word.
  const space = tail.indexOf(" ");
  return space > 0 ? tail.slice(space + 1) : tail;
}

/**
 * Structure-aware chunker.
 *
 * - honours markdown headings and paragraph breaks
 * - targets a character budget with a small overlap
 * - prefixes the embedded text with a document/section breadcrumb
 * - keeps page + character offsets for citations
 */
export function chunkDocument({
  title,
  pages,
}: {
  title: string;
  pages: PageInput[];
}): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  const { chunkTargetChars, chunkOverlapChars, minChunkChars } = ragConfig;

  for (const page of pages) {
    const blocks = blocksFromPage(page);
    if (!blocks.length) continue;

    let current: Block[] = [];
    let currentChars = 0;
    let pendingOverlap = "";

    const emit = (carryOverlap = true) => {
      if (!current.length) return;
      const body = current.map((block) => block.text).join("\n\n").trim();
      if (!body) {
        current = [];
        return;
      }

      const text = pendingOverlap ? `${pendingOverlap}\n\n${body}` : body;
      const headingPath = current[0].headingPath;

      chunks.push({
        index: chunks.length,
        text,
        embedText: buildEmbedText(title, headingPath, text),
        headingPath,
        page: current[0].page,
        startChar: current[0].startChar,
        endChar: current[current.length - 1].endChar,
        tokens: estimateTokens(text),
      });

      pendingOverlap = carryOverlap ? tailForOverlap(body, chunkOverlapChars) : "";
      current = [];
      currentChars = 0;
    };

    for (const block of blocks) {
      // Never mix two sections in one chunk: heading context would be wrong.
      if (
        current.length &&
        current[0].headingPath.join(" > ") !== block.headingPath.join(" > ")
      ) {
        emit(false);
      }

      if (block.text.length > chunkTargetChars) {
        emit();
        const pieces = splitOversized(block.text, chunkTargetChars);
        for (const piece of pieces) {
          current = [{ ...block, text: piece }];
          currentChars = piece.length;
          emit();
        }
        continue;
      }

      const projected = currentChars + block.text.length + 2 + pendingOverlap.length;
      if (current.length && projected > chunkTargetChars) {
        emit();
      }

      if (!current.length) {
        currentChars = pendingOverlap.length;
      }
      current.push(block);
      currentChars += block.text.length + 2;
    }

    emit();

    // Overlap is only meaningful inside a page.
    pendingOverlap = "";
  }

  // Fold a tiny trailing chunk into its predecessor when it fits.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    const previous = chunks[chunks.length - 2];
    if (
      last.text.length < minChunkChars &&
      last.page === previous.page &&
      last.headingPath.join(" > ") === previous.headingPath.join(" > ") &&
      previous.text.length + last.text.length < chunkTargetChars * 1.2
    ) {
      previous.text = `${previous.text}\n\n${last.text}`;
      previous.embedText = buildEmbedText(title, previous.headingPath, previous.text);
      previous.endChar = last.endChar;
      previous.tokens = estimateTokens(previous.text);
      chunks.pop();
    }
  }

  return chunks.map((chunk, index) => ({ ...chunk, index }));
}
