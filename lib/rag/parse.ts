import { extractText } from "unpdf";
import { ragConfig } from "./config";

export type ParsedPage = { text: string; page: number | null };

export type ParsedDocument = {
  pages: ParsedPage[];
  pageCount: number;
  mime: string;
};

const TEXT_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".log",
  ".yml",
  ".yaml",
];

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

function isTextLike(name: string, mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json") return true;
  return TEXT_EXTENSIONS.includes(extension(name));
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]{2,}/g, " ");
}

export function assertParsable(name: string, mime: string): void {
  const isPdf = mime === "application/pdf" || extension(name) === ".pdf";
  const isHtml = mime === "text/html" || [".html", ".htm"].includes(extension(name));
  if (isPdf || isHtml || isTextLike(name, mime)) return;

  throw new Error(
    `Unsupported file type "${mime || extension(name) || name}". ` +
      `Supported: PDF, HTML, and text-like formats (${TEXT_EXTENSIONS.join(", ")}).`,
  );
}

export async function parseDocument(file: File): Promise<ParsedDocument> {
  const name = file.name;
  const mime = file.type || "application/octet-stream";
  const buffer = await file.arrayBuffer();

  if (mime === "application/pdf" || extension(name) === ".pdf") {
    const { text, totalPages } = await extractText(new Uint8Array(buffer), {
      mergePages: false,
    });
    return {
      pages: text.map((pageText, index) => ({ text: pageText, page: index + 1 })),
      pageCount: totalPages,
      mime,
    };
  }

  const decoded = new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, "");
  const isHtml = mime === "text/html" || [".html", ".htm"].includes(extension(name));
  const content = isHtml ? stripHtml(decoded) : decoded;

  return {
    pages: [{ text: content, page: null }],
    pageCount: 1,
    mime,
  };
}

export function assertFileSize(bytes: number): void {
  if (bytes === 0) throw new Error("The uploaded file is empty.");
  if (bytes > ragConfig.maxFileBytes) {
    const limit = Math.round(ragConfig.maxFileBytes / (1024 * 1024));
    throw new Error(`File is larger than the ${limit} MB limit.`);
  }
}
