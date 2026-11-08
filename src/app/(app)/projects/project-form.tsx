"use client";

import { useActionState, useEffect, useRef } from "react";
import { Loader2, Plus } from "lucide-react";
import { createProject, type ActionState } from "../actions";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label, Textarea } from "@/components/ui/input";

export function ProjectForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(createProject, { ok: false });
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="space-y-4">
      <div>
        <Label htmlFor="name">Project name</Label>
        <Input id="name" name="name" maxLength={120} placeholder="e.g. Retrieval-augmented generation survey" required aria-invalid={!!state.fieldErrors?.name} />
        <FieldError messages={state.fieldErrors?.name} />
      </div>
      <div>
        <Label htmlFor="description">Description <span className="font-normal text-subtle">(optional)</span></Label>
        <Textarea id="description" name="description" maxLength={2000} rows={3} />
        <FieldError messages={state.fieldErrors?.description} />
      </div>
      {state.message && !state.ok && <p className="text-sm text-danger">{state.message}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        Create project
      </Button>
    </form>
  );
}
