import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { storageBucket } from "@/lib/env.server";
import { idParamSchema } from "@/lib/validation";

/** Authorised viewing: verify identity + ownership, then redirect to a 60-second signed URL. */
export async function GET(request: NextRequest, ctx: RouteContext<"/documents/[id]/file">) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  const parsed = idParamSchema.safeParse(await ctx.params);
  if (!parsed.success) return new NextResponse("Not found", { status: 404 });

  const supabase = await createClient();
  const { data: doc } = await supabase
    .from("documents")
    .select("id, owner_id, storage_path, status")
    .eq("id", parsed.data.id)
    .maybeSingle();
  if (!doc || doc.owner_id !== user.id || doc.status === "pending_upload" || doc.status === "failed") {
    return new NextResponse("Not found", { status: 404 });
  }

  const { data, error } = await supabase.storage.from(storageBucket()).createSignedUrl(doc.storage_path, 60);
  if (error || !data) return new NextResponse("Unavailable", { status: 502 });

  const res = NextResponse.redirect(data.signedUrl);
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}
