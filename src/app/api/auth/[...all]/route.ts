import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";

const handlers = toNextJsHandler(auth);
function unavailable() {
  return Response.json(
    { code: "AUTH_UNAVAILABLE", message: "Authentication is temporarily unavailable." },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

// Preserve Better Auth's cookies, origin/CSRF checks, and ordinary auth errors.
// Unexpected failures never expose adapter details, stack traces, or credentials.
async function handle(request: Request) {
  try {
    const response = await handlers[request.method === "GET" ? "GET" : "POST"](request);
    if (response.status >= 500) return unavailable();
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return unavailable();
  }
}

export const GET = handle;
export const POST = handle;
