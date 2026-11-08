import { z } from "zod";

export const MAX_PDF_BYTES = 50 * 1024 * 1024; // matches the bucket's file_size_limit
export const uuid = z.uuid();

export const emailSchema = z.email("Enter a valid email address.").max(254).trim().toLowerCase();

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password.").max(128),
  next: z.string().max(512).optional(),
});

export const signupSchema = z.object({
  displayName: z.string().trim().min(1, "Enter your name.").max(120),
  email: emailSchema,
  password: z
    .string()
    .min(8, "Use at least 8 characters.")
    .max(128, "Use at most 128 characters.")
    .regex(/[A-Za-z]/, "Include at least one letter.")
    .regex(/[0-9]/, "Include at least one number."),
});

export const projectSchema = z.object({
  name: z.string().trim().min(1, "Give the project a name.").max(120),
  description: z.string().trim().max(2000).optional().transform((v) => v || null),
});

export const MAX_NOTE_BYTES = 15 * 1024 * 1024;
export const NOTE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export const uploadRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("paper"),
    projectId: uuid,
    filename: z.string().trim().min(1).max(255),
    size: z.number().int().positive().max(MAX_PDF_BYTES, "PDF exceeds the 50 MB limit."),
    mimeType: z.literal("application/pdf", { error: "Only PDF files are accepted." }),
  }),
  z.object({
    kind: z.literal("note"),
    projectId: uuid,
    filename: z.string().trim().min(1).max(255),
    size: z.number().int().positive().max(MAX_NOTE_BYTES, "Note image exceeds the 15 MB limit."),
    mimeType: z.enum(NOTE_MIME_TYPES, { error: "Notes must be PNG, JPEG or WebP images." }),
  }),
]);

export const idParamSchema = z.object({ id: uuid });

export const askSchema = z.object({
  projectId: uuid,
  documentIds: z.array(uuid).max(50).optional(),
  question: z.string().trim().min(3, "Ask a longer question.").max(1000, "Keep questions under 1000 characters."),
});
