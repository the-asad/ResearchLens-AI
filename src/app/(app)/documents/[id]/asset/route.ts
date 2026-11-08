import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { signedDerivedAssetUrl } from "@/lib/documents";
import { idParamSchema, uuid } from "@/lib/validation";

/** Open a derived asset (figure crop) of one of the caller's chunks: RLS read → owner-prefix check → 60 s signed URL. */
export async function GET(request: NextRequest, ctx: RouteContext<"/documents/[id]/asset">) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  const params = idParamSchema.safeParse(await ctx.params);
  const chunk = uuid.safeParse(request.nextUrl.searchParams.get("chunk"));
  if (!params.success || !chunk.success) return new NextResponse("Not found", { status: 404 });

  const supabase = await createClient();
  const { data } = await supabase
    .from("document_chunks")
    .select("id, owner_id, project_id, document_id, source_asset_path")
    .eq("id", chunk.data)
    .eq("document_id", params.data.id)
    .maybeSingle();
  if (!data || data.owner_id !== user.id || !data.source_asset_path) return new NextResponse("Not found", { status: 404 });

  const url = await signedDerivedAssetUrl(user.id, data.project_id, data.document_id, data.source_asset_path);
  if (!url) return new NextResponse("Not found", { status: 404 });
  const res = NextResponse.redirect(url);
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}
