"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { publicEnv } from "@/lib/env";
import { loginSchema, signupSchema } from "@/lib/validation";
import { safeNextPath } from "@/lib/routes";

export type AuthState = {
  error?: string;
  notice?: string;
  fieldErrors?: Record<string, string[] | undefined>;
  values?: { email?: string; displayName?: string };
};

export async function login(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });
  const email = String(formData.get("email") ?? "").slice(0, 254);
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors, values: { email } };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) {
    // Generic message: do not reveal whether the account exists.
    const message =
      error.code === "email_not_confirmed"
        ? "Please confirm your email address before signing in."
        : error.status === 429
          ? "Too many attempts. Please wait a moment and try again."
          : "Invalid email or password.";
    return { error: message, values: { email } };
  }

  redirect(safeNextPath(parsed.data.next));
}

export async function signup(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = signupSchema.safeParse({
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  const values = {
    email: String(formData.get("email") ?? "").slice(0, 254),
    displayName: String(formData.get("displayName") ?? "").slice(0, 120),
  };
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors, values };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { display_name: parsed.data.displayName },
      emailRedirectTo: `${publicEnv().NEXT_PUBLIC_APP_URL}/auth/callback?next=/dashboard`,
    },
  });
  if (error) {
    const message =
      error.code === "weak_password"
        ? "That password is too weak. Choose a stronger one."
        : error.status === 429
          ? "Too many attempts. Please wait a moment and try again."
          : "Could not create the account. Please try again.";
    return { error: message, values };
  }

  if (data.session) redirect("/dashboard");
  return {
    notice: "Check your inbox to confirm your email address, then sign in.",
    values,
  };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
