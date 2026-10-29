import { headers } from "next/headers";
import { auth } from "@/lib/auth";

/**
 * Real sessions when signed in; a stable dev identity otherwise so the demo is
 * usable before auth is wired into the UI. Set RAG_DEV_USER_ID to force a
 * specific bucket.
 */
export async function currentUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session?.user?.id) return session.user.id;
  return process.env.RAG_DEV_USER_ID ?? "dev-user";
}

export function errorResponse(error: unknown, status = 500) {
  const message =
    error instanceof Error ? error.message : "Something went wrong";
  return Response.json({ error: message }, { status });
}
