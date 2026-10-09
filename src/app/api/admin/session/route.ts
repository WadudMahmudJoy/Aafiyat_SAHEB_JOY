import { requireAdminEntry } from "@/lib/admin-entry";
import { AdminAuthorizationError } from "@/lib/admin-authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store, private", "Vary": "Cookie" };
  try {
    const principal = await requireAdminEntry(request.headers);
    return Response.json({ role: principal.role }, { headers });
  } catch (error) {
    const unavailable = !(error instanceof AdminAuthorizationError) || error.reason === "AUTHORIZATION_UNAVAILABLE";
    return Response.json({ message: unavailable ? "Service temporarily unavailable." : "Authentication required." },
      { status: unavailable ? 503 : 401, headers });
  }
}
