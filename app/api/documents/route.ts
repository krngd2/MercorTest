import { ingestFile, listDocuments } from "@/lib/rag/ingest";
import { currentUserId, errorResponse } from "@/lib/rag/session";

export async function GET() {
  try {
    const userId = await currentUserId();
    return Response.json({ documents: await listDocuments(userId) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse("Expected multipart/form-data with a `file` field.", 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return errorResponse("Missing `file` field.", 400);
  }

  try {
    const userId = await currentUserId();
    const document = await ingestFile({ userId, file });
    return Response.json({ document }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const isValidation =
      /unsupported|empty|larger than|no extractable/i.test(message);
    return errorResponse(error, isValidation ? 400 : 500);
  }
}
