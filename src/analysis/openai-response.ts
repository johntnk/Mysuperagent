import { z } from 'zod';

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
}
export interface ModelResult<T> {
  data: T;
  usage: ModelUsage;
  response_id: string;
  model: string;
  request_id: string | null;
  service_tier?: string;
}
export class ModelRequestError extends Error {
  constructor(
    public code: string,
    public usage: ModelUsage | null = null,
    public response_id: string | null = null,
  ) {
    super(code);
  }
}

/** Shared by the deployed planner and local history observer. Never logs credentials or error bodies. */
export async function structuredResponse<T>(options: {
  apiKey: string;
  baseUrl: string;
  model: string;
  instructions: string;
  input: unknown;
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens: number;
  signal: AbortSignal;
  serviceTier?: 'default';
  transport?: typeof fetch;
  /** Optional images (data URLs) sent alongside the JSON input as `input_image` parts. */
  images?: string[];
}): Promise<ModelResult<T>> {
  if (options.baseUrl !== 'https://api.openai.com/v1')
    throw new ModelRequestError('unsupported_model_endpoint');
  const text = JSON.stringify(options.input);
  const input = options.images?.length
    ? [
        {
          role: 'user',
          content: [
            { type: 'input_text', text },
            ...options.images.map((image_url) => ({ type: 'input_image', image_url })),
          ],
        },
      ]
    : text;
  const response = await (options.transport ?? fetch)(`${options.baseUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
    redirect: 'error',
    signal: options.signal,
    body: JSON.stringify({
      model: options.model,
      store: false,
      reasoning: { effort: 'medium' },
      max_output_tokens: options.maxOutputTokens,
      ...(options.serviceTier ? { service_tier: options.serviceTier } : {}),
      instructions: options.instructions,
      input,
      text: {
        format: {
          type: 'json_schema',
          name: options.schemaName,
          strict: true,
          schema: z.toJSONSchema(options.schema, { target: 'draft-7' }),
        },
      },
    }),
  });
  if (!response.ok) {
    const body: any = await response.json().catch(() => null);
    const code = String(body?.error?.code ?? '')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 80);
    throw new ModelRequestError(`MODEL_HTTP_${response.status}${code ? `_${code}` : ''}`);
  }
  const body: any = await response.json();
  const usage: ModelUsage = {
    input_tokens: Number(body.usage?.input_tokens ?? 0),
    output_tokens: Number(body.usage?.output_tokens ?? 0),
    cached_input_tokens: Number(body.usage?.input_tokens_details?.cached_tokens ?? 0),
  };
  if (body.status !== 'completed')
    throw new ModelRequestError('model_response_incomplete', usage, body.id ?? null);
  const texts =
    body.output
      ?.flatMap((o: any) => (o.type === 'message' ? o.content || [] : []))
      .filter((x: any) => x.type === 'output_text')
      .map((x: any) => x.text) || [];
  if (texts.length !== 1)
    throw new ModelRequestError('model_refusal_or_missing_output', usage, body.id ?? null);
  try {
    return {
      data: options.schema.parse(JSON.parse(texts[0])),
      usage,
      response_id: body.id,
      model: body.model,
      request_id: response.headers.get('x-request-id'),
      service_tier: body.service_tier,
    };
  } catch {
    throw new ModelRequestError('invalid_structured_output', usage, body.id ?? null);
  }
}
