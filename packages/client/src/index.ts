import {
  AsyncScheduleRequestSchema,
  AsyncTriggerRequestSchema,
  AuthConfig,
  ChatStreamRequest,
  ChatStreamRequestSchema,
  ProviderCapability,
  ProviderCapabilitySchema,
  ProviderDiscoverySchema,
  ProviderKind,
  PushRegistration,
  PushRegistrationSchema,
  StreamEvent,
  StreamEventSchema
} from "@birdhouse/protocol";

export interface EndpointTarget {
  baseUrl: string;
  auth?: AuthConfig;
}

export interface BirdhouseClientOptions {
  fetchFn?: typeof fetch;
}

const defaultHeaders: Record<string, string> = {
  "Content-Type": "application/json"
};

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function encodeBase64(value: string): string {
  if (typeof btoa === "function") {
    return btoa(value);
  }

  const bufferCtor = (globalThis as { Buffer?: { from(input: string, encoding: string): { toString(encoding: string): string } } }).Buffer;
  if (bufferCtor) {
    return bufferCtor.from(value, "utf-8").toString("base64");
  }

  throw new Error("Unable to encode basic auth credentials in this runtime.");
}

export function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${normalizedPath}`;
}

export function buildAuthHeaders(auth?: AuthConfig): Record<string, string> {
  if (!auth || auth.type === "none") {
    return {};
  }

  if (auth.type === "bearer") {
    return {
      Authorization: `Bearer ${auth.token}`
    };
  }

  const encoded = encodeBase64(`${auth.username}:${auth.password}`);
  return {
    Authorization: `Basic ${encoded}`
  };
}

async function *parseSseData(response: Response): AsyncGenerator<string> {
  if (!response.body) {
    const payload = await response.text();
    for (const item of parseSsePayloadFromText(payload)) {
      yield item;
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const normalized = buffer.replace(/\r\n/g, "\n");
      const boundary = normalized.indexOf("\n\n");
      if (boundary === -1) {
        break;
      }

      const rawEvent = normalized.slice(0, boundary);
      buffer = normalized.slice(boundary + 2);

      for (const data of parseSsePayloadFromText(rawEvent)) {
        yield data;
      }
    }
  }

  const trailing = `${buffer}${decoder.decode()}`;
  for (const data of parseSsePayloadFromText(trailing)) {
    yield data;
  }
}

function parseSsePayloadFromText(payload: string): string[] {
  const normalized = payload.replace(/\r\n/g, "\n");
  const data: string[] = [];

  for (const block of normalized.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) {
        continue;
      }

      const item = line.slice(5).trim();
      if (item.length > 0) {
        data.push(item);
      }
    }
  }

  return data;
}

export interface ChatStreamParams {
  endpoint: EndpointTarget;
  request: ChatStreamRequest;
}

export interface AsyncTriggerParams {
  endpoint: EndpointTarget;
  request: unknown;
}

export interface AsyncScheduleParams {
  endpoint: EndpointTarget;
  request: unknown;
}

export interface PushRegistrationParams {
  endpoint: EndpointTarget;
  registration: PushRegistration;
}

export class BirdhouseClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: BirdhouseClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async *chatStream(params: ChatStreamParams): AsyncGenerator<StreamEvent> {
    const parsedRequest = ChatStreamRequestSchema.parse(params.request);

    const response = await this.fetchFn(joinUrl(params.endpoint.baseUrl, "/v1/chat.stream"), {
      method: "POST",
      headers: {
        ...defaultHeaders,
        Accept: "text/event-stream",
        ...buildAuthHeaders(params.endpoint.auth)
      },
      body: JSON.stringify(parsedRequest)
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`chat.stream failed (${response.status}): ${bodyText}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const fallbackPayload = await response.json();
      if (Array.isArray(fallbackPayload?.events)) {
        for (const event of fallbackPayload.events) {
          yield StreamEventSchema.parse(event);
        }
        return;
      }

      const text = typeof fallbackPayload?.text === "string" ? fallbackPayload.text : "";
      yield {
        type: "message_start",
        messageId: randomId(),
        threadId: parsedRequest.threadId,
        createdAt: new Date().toISOString()
      };
      yield {
        type: "token",
        text
      };
      yield {
        type: "message_end",
        messageId: randomId(),
        text,
        status: "received",
        createdAt: new Date().toISOString()
      };
      return;
    }

    for await (const data of parseSseData(response)) {
      if (!data || data === "[DONE]") {
        continue;
      }

      try {
        const json = JSON.parse(data);
        yield StreamEventSchema.parse(json);
      } catch {
        yield {
          type: "token",
          text: data
        };
      }
    }
  }

  async registerPush(params: PushRegistrationParams): Promise<{ ok: true }> {
    const payload = PushRegistrationSchema.parse(params.registration);

    const response = await this.fetchFn(joinUrl(params.endpoint.baseUrl, "/v1/push/register"), {
      method: "POST",
      headers: {
        ...defaultHeaders,
        ...buildAuthHeaders(params.endpoint.auth)
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`push.register failed (${response.status}): ${await response.text()}`);
    }

    return { ok: true };
  }

  async triggerAsync(params: AsyncTriggerParams): Promise<{ queued: boolean }> {
    const payload = AsyncTriggerRequestSchema.parse(params.request);
    const response = await this.fetchFn(joinUrl(params.endpoint.baseUrl, "/v1/async/trigger"), {
      method: "POST",
      headers: {
        ...defaultHeaders,
        ...buildAuthHeaders(params.endpoint.auth)
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`async.trigger failed (${response.status}): ${await response.text()}`);
    }

    return { queued: true };
  }

  async scheduleAsync(params: AsyncScheduleParams): Promise<{ scheduled: boolean; delaySeconds: number }> {
    const payload = AsyncScheduleRequestSchema.parse(params.request);
    const response = await this.fetchFn(joinUrl(params.endpoint.baseUrl, "/v1/async/schedule"), {
      method: "POST",
      headers: {
        ...defaultHeaders,
        ...buildAuthHeaders(params.endpoint.auth)
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`async.schedule failed (${response.status}): ${await response.text()}`);
    }

    return {
      scheduled: true,
      delaySeconds: payload.delaySeconds
    };
  }

  async listCapabilities(endpoint: EndpointTarget): Promise<ProviderCapability[]> {
    const response = await this.fetchFn(joinUrl(endpoint.baseUrl, "/v1/providers/capabilities"), {
      method: "GET",
      headers: {
        ...buildAuthHeaders(endpoint.auth)
      }
    });

    if (!response.ok) {
      throw new Error(`providers.capabilities failed (${response.status}): ${await response.text()}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload?.capabilities)) {
      return [];
    }

    return payload.capabilities.map((capability: unknown) => ProviderCapabilitySchema.parse(capability));
  }

  async discoverProvider(endpoint: EndpointTarget): Promise<ProviderKind> {
    const fallbackProvider: ProviderKind = "terminal-cli";
    const response = await this.fetchFn(joinUrl(endpoint.baseUrl, "/v1/providers/default"), {
      method: "GET",
      headers: {
        ...buildAuthHeaders(endpoint.auth)
      }
    });

    if (response.ok) {
      const payload = await response.json();
      const discovered = ProviderDiscoverySchema.safeParse(payload);
      if (discovered.success) {
        return discovered.data.kind;
      }
    }

    let capabilities: ProviderCapability[] = [];
    try {
      capabilities = await this.listCapabilities(endpoint);
    } catch {
      return fallbackProvider;
    }

    if (!capabilities.length) {
      return fallbackProvider;
    }

    if (capabilities.length === 1) {
      return capabilities[0].kind;
    }

    const aiSdk = capabilities.find((capability) => capability.kind === "ai-sdk");
    if (aiSdk) {
      return aiSdk.kind;
    }

    return capabilities[0].kind;
  }
}

export function createBirdhouseClient(options?: BirdhouseClientOptions): BirdhouseClient {
  return new BirdhouseClient(options);
}
