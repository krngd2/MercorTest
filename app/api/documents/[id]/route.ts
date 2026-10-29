import { deleteDocument } from "@/lib/rag/ingest";
import { currentUserId, errorResponse } from "@/lib/rag/session";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const userId = await currentUserId();
    const deleted = await deleteDocument(userId, id);
    if (!deleted) {
      return errorResponse("Document not found.", 404);
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
