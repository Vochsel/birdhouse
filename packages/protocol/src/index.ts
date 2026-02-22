import { z } from "zod";

export const ProviderKindSchema = z.enum([
  "ai-sdk",
  "openclaw",
  "pi-mono",
  "terminal-cli",
  "claude-code-cli",
  "openclaw-cli",
  "nanoclaw-cli"
]);

export const AuthConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("none")
  }),
  z.object({
    type: z.literal("bearer"),
    token: z.string().min(1)
  }),
  z.object({
    type: z.literal("basic"),
    username: z.string().min(1),
    password: z.string().min(1)
  })
]);

export const ProviderConfigSchema = z.object({
  kind: ProviderKindSchema,
  baseUrl: z.string().url(),
  auth: AuthConfigSchema.default({ type: "none" }),
  extra: z.record(z.string(), z.unknown()).default({})
});

export const ContactSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  provider: ProviderConfigSchema
});

export const AttachmentSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.enum(["image", "file"]),
  name: z.string().min(1),
  mimeType: z.string().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  uri: z.string().min(1).optional(),
  dataBase64: z.string().min(1).optional()
});

export const ChatRoleSchema = z.enum(["user", "agent", "system"]);

export const MessageStatusSchema = z.enum([
  "sending",
  "sent",
  "received",
  "read",
  "failed",
  "streaming"
]);

export const MessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  role: ChatRoleSchema,
  text: z.string(),
  attachments: z.array(AttachmentSchema).default([]),
  status: MessageStatusSchema.default("sent"),
  createdAt: z.string().datetime()
});

export const OutboundMessageInputSchema = z.object({
  id: z.string().min(1).optional(),
  text: z.string(),
  attachments: z.array(AttachmentSchema).default([])
});

export const ChatStreamRequestSchema = z.object({
  threadId: z.string().min(1),
  contact: ContactSchema,
  message: OutboundMessageInputSchema,
  history: z.array(MessageSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const MessageStartEventSchema = z.object({
  type: z.literal("message_start"),
  messageId: z.string().min(1),
  threadId: z.string().min(1),
  createdAt: z.string().datetime()
});

export const TokenEventSchema = z.object({
  type: z.literal("token"),
  text: z.string()
});

export const AttachmentEventSchema = z.object({
  type: z.literal("attachment"),
  attachment: AttachmentSchema
});

export const TypingEventSchema = z.object({
  type: z.literal("typing"),
  isTyping: z.boolean()
});

export const MessageEndEventSchema = z.object({
  type: z.literal("message_end"),
  messageId: z.string().min(1),
  text: z.string(),
  status: MessageStatusSchema,
  createdAt: z.string().datetime()
});

export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean().default(false)
});

export const StreamEventSchema = z.discriminatedUnion("type", [
  MessageStartEventSchema,
  TokenEventSchema,
  AttachmentEventSchema,
  TypingEventSchema,
  MessageEndEventSchema,
  ErrorEventSchema
]);

export const PushRegistrationSchema = z.object({
  contactId: z.string().min(1),
  threadId: z.string().min(1),
  expoPushToken: z.string().min(1),
  platform: z.enum(["ios", "android"])
});

export const AsyncTriggerRequestSchema = z.object({
  contact: ContactSchema,
  threadId: z.string().min(1),
  text: z.string().optional()
});

export const AsyncScheduleRequestSchema = z.object({
  contact: ContactSchema,
  threadId: z.string().min(1),
  delaySeconds: z.number().int().positive().max(3600),
  text: z.string().optional()
});

export const ProviderCapabilitySchema = z.object({
  kind: ProviderKindSchema,
  supportsStreaming: z.boolean(),
  supportsAttachments: z.boolean(),
  supportsAsync: z.boolean()
});

export const ProviderDiscoverySchema = z.object({
  kind: ProviderKindSchema
});

export type ProviderKind = z.infer<typeof ProviderKindSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type Contact = z.infer<typeof ContactSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type OutboundMessageInput = z.infer<typeof OutboundMessageInputSchema>;
export type ChatStreamRequest = z.infer<typeof ChatStreamRequestSchema>;
export type StreamEvent = z.infer<typeof StreamEventSchema>;
export type PushRegistration = z.infer<typeof PushRegistrationSchema>;
export type AsyncTriggerRequest = z.infer<typeof AsyncTriggerRequestSchema>;
export type AsyncScheduleRequest = z.infer<typeof AsyncScheduleRequestSchema>;
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;
export type ProviderDiscovery = z.infer<typeof ProviderDiscoverySchema>;
