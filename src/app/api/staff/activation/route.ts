import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { staffActivation } from "@/lib/staff-activation";
import { ONBOARDING_COOKIE } from "@/lib/staff-onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = {
  "Cache-Control": "no-store, private",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
const rejected = () => NextResponse.json({ ok: false, message: "Unable to continue onboarding." }, { status: 400, headers });

export async function POST(request: NextRequest) {
  try {
    const origin = auth.options.baseURL;
    if (typeof origin !== "string" || request.headers.get("origin") !== origin ||
      request.headers.get("sec-fetch-site") === "cross-site" ||
      request.headers.get("x-staff-onboarding") !== "1" ||
      request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json" || !request.body) return rejected();

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4096) return rejected();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) return rejected();
    const fields = body as Record<string, unknown>;
    const count = Object.keys(fields).length;
    const op = fields.operation;
    const input = op === "status" && count === 1 ? { operation: op } as const :
      op === "setup" && count === 2 && typeof fields.password === "string" && fields.password.length >= 12 && fields.password.length <= 128
        ? { operation: op, password: fields.password } as const :
      op === "activate" && count === 2 && typeof fields.code === "string" && /^\d{6}$/.test(fields.code)
        ? { operation: op, code: fields.code } as const : null;
    if (!input) return rejected();

    // Read cookie configuration before the transaction so a configuration error
    // cannot turn a committed activation into an apparent failure response.
    const context = await auth.$context;
    const { result, clearCookies } = await staffActivation(request.headers, input);
    const response = NextResponse.json(result, { headers });
    if (clearCookies) {
      for (const cookie of [...Object.values(context.authCookies), context.createAuthCookie("two_factor")]) {
        response.cookies.set(cookie.name, "", {
          path: cookie.attributes.path ?? "/",
          domain: cookie.attributes.domain,
          secure: cookie.attributes.secure,
          httpOnly: true,
          sameSite: "lax",
          maxAge: 0,
        });
      }
      response.cookies.set(ONBOARDING_COOKIE, "", {
        path: "/api/staff/onboarding", secure: new URL(origin).protocol === "https:", httpOnly: true, sameSite: "strict", maxAge: 0,
      });
    }
    return response;
  } catch {
    return rejected();
  }
}
