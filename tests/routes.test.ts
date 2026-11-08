import { describe, expect, it } from "vitest";
import { isAuthPath, isProtectedPath, safeNextPath } from "@/lib/routes";

describe("route protection", () => {
  it.each(["/dashboard", "/documents", "/documents/abc/file", "/projects", "/settings/x"])("%s is protected", (p) =>
    expect(isProtectedPath(p)).toBe(true),
  );
  it.each(["/", "/login", "/signup", "/auth/callback", "/dashboardx"])("%s is public", (p) =>
    expect(isProtectedPath(p)).toBe(false),
  );
  it("identifies auth pages", () => {
    expect(isAuthPath("/login")).toBe(true);
    expect(isAuthPath("/signup")).toBe(true);
    expect(isAuthPath("/dashboard")).toBe(false);
  });
});

describe("safeNextPath (open-redirect protection)", () => {
  it("allows relative paths", () => expect(safeNextPath("/documents?project=1")).toBe("/documents?project=1"));
  it.each(["//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)", "", null, 42, "/a\nb"])(
    "rejects %s",
    (v) => expect(safeNextPath(v)).toBe("/dashboard"),
  );
});
