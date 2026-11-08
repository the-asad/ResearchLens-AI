"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/input";
import { login, signup, type AuthState } from "./actions";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const [state, action, pending] = useActionState<AuthState, FormData>(mode === "login" ? login : signup, {});
  const params = useSearchParams();
  const next = params.get("next") ?? "";
  const urlError = params.get("error");

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">
        {mode === "login" ? "Sign in to your workspace" : "Create your workspace"}
      </h1>
      <p className="mt-2 text-sm text-muted">
        {mode === "login" ? "Welcome back. Enter your details to continue." : "Start organising and verifying your research."}
      </p>

      {(state.error || urlError) && (
        <div role="alert" className="mt-6 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {state.error ?? "That sign-in link is invalid or has expired. Please try again."}
        </div>
      )}
      {state.notice && (
        <div role="status" className="mt-6 rounded-lg border border-success/20 bg-success-soft px-3 py-2.5 text-sm text-success">
          {state.notice}
        </div>
      )}

      <form action={action} className="mt-6 space-y-4" noValidate>
        {mode === "login" && <input type="hidden" name="next" value={next} />}
        {mode === "signup" && (
          <div>
            <Label htmlFor="displayName">Name</Label>
            <Input
              id="displayName"
              name="displayName"
              autoComplete="name"
              defaultValue={state.values?.displayName}
              aria-invalid={!!state.fieldErrors?.displayName}
              maxLength={120}
              required
            />
            <FieldError messages={state.fieldErrors?.displayName} />
          </div>
        )}
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            defaultValue={state.values?.email}
            aria-invalid={!!state.fieldErrors?.email}
            maxLength={254}
            required
          />
          <FieldError messages={state.fieldErrors?.email} />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            aria-invalid={!!state.fieldErrors?.password}
            maxLength={128}
            required
          />
          {mode === "signup" && !state.fieldErrors?.password && (
            <p className="mt-1.5 text-[13px] text-subtle">At least 8 characters, including a letter and a number.</p>
          )}
          <FieldError messages={state.fieldErrors?.password} />
        </div>
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending && <Loader2 className="size-4 animate-spin" />}
          {mode === "login" ? "Sign in" : "Create account"}
        </Button>
      </form>

      <p className="mt-6 text-sm text-muted">
        {mode === "login" ? (
          <>
            New to ResearchLens?{" "}
            <Link href="/signup" className="font-medium text-accent hover:underline">
              Create an account
            </Link>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-accent hover:underline">
              Sign in
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
