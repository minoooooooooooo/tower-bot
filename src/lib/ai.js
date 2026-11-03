import { config } from '../config.js';
import { createLogger } from './logger.js';

const logger = createLogger('ai');

export class AiError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.retryable = retryable;
  }
}

export function aiConfigured() {
  return Boolean(config.ai.apiKey);
}

export function aiLabel() {
  return config.ai.model;
}

/** Plain-language hint for the admin when the request fails. */
export function aiProblemHint(error) {
  if (!(error instanceof AiError)) return 'The AI request failed. Check the bot log for details.';

  if (error.status === 401 || error.status === 403) {
    return 'The AI key was rejected. Check `AI_API_KEY` in the server environment.';
  }

  if (error.status === 404) {
    const hint = config.ai.baseUrl.includes('googleapis.com')
      ? 'Google retires model ids for new keys: try `AI_MODEL=gemini-3.6-flash` (or `gemini-3.5-flash-lite`).'
      : config.ai.baseUrl.includes('deepseek.com')
        ? 'Check the model id on the DeepSeek platform: `AI_MODEL=deepseek-flash`.'
        : 'Check the model id and base URL for this provider.';

    return [
      `The model \`${config.ai.model}\` is not available at \`${config.ai.baseUrl}\`.`,
      `Provider said: ${error.message}`,
      hint,
    ].join('\n');
  }

  if (error.status === 429) {
    return 'The AI provider is rate limiting the key. Wait a minute and try again, or use a smaller time window.';
  }

  if (error.status === 400) {
    return `The AI provider rejected the request: ${error.message}`;
  }

  if (error.status >= 500) {
    return 'The AI provider had a server error. Try again in a moment.';
  }

  return error.message;
}

function endpoint() {
  return `${config.ai.baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

async function post(payload, timeoutMs) {
  const response = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.ai.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error) => {
    // Aborts and DNS failures both land here; neither is retryable in a way
    // that helps the user.
    throw new AiError(`Could not reach the AI provider (${error.message}).`, { retryable: true });
  });

  if (response.ok) return response.json();

  let detail = `HTTP ${response.status}`;

  try {
    const body = await response.json();
    detail = body?.error?.message ?? body?.message ?? detail;
  } catch {
    // Non-JSON error body; the status is all we have.
  }

  throw new AiError(String(detail).slice(0, 300), {
    status: response.status,
    retryable: response.status === 429 || response.status >= 500,
  });
}

/**
 * Pulls the first JSON object out of a reply. Models wrap JSON in code fences
 * or add a sentence before it often enough that this is worth doing rather
 * than trusting `response_format`.
 */
export function extractJson(text) {
  const trimmed = String(text ?? '').trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');

  if (start === -1 || end <= start) {
    throw new AiError('The model did not return JSON.', { retryable: true });
  }

  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch (error) {
    throw new AiError(`The model returned invalid JSON (${error.message}).`, { retryable: true });
  }
}

/**
 * One chat completion that must return a JSON object. Retries once on rate
 * limits and server errors because a summary is expensive to redo by hand.
 */
export async function chatJson({ system, user, maxTokens = 2000, temperature = 0.2, timeoutMs = 90_000 }) {
  if (!aiConfigured()) {
    throw new AiError('AI is not configured. Set `AI_API_KEY` on the host.', { status: 0 });
  }

  const payload = {
    model: config.ai.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  };

  // DeepSeek and other reasoning models think by default: the chain of thought
  // is billed as output and can eat the whole max_tokens budget before the JSON
  // starts. Summaries do not need it, so AI_THINKING=off keeps the answer
  // inside the budget and the bill predictable. Unset sends nothing, leaving
  // Gemini and the other providers exactly as before.
  if (['off', 'disabled', 'false'].includes(config.ai.thinking)) {
    payload.thinking = { type: 'disabled' };
  } else if (['on', 'enabled', 'true'].includes(config.ai.thinking)) {
    payload.thinking = { type: 'enabled' };
  }

  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const body = await post(payload, timeoutMs);
      const content = body?.choices?.[0]?.message?.content;

      if (!content) throw new AiError('The model returned an empty reply.', { retryable: true });

      if (body?.usage) {
        logger.info(
          `AI usage (${config.ai.model}): ${body.usage.prompt_tokens ?? '?'} input, ${body.usage.completion_tokens ?? '?'} output tokens`,
        );
      }

      return { data: extractJson(content), usage: body?.usage ?? null };
    } catch (error) {
      lastError = error;

      if (!(error instanceof AiError) || !error.retryable || attempt === 2) break;

      logger.warn(`AI request failed (attempt ${attempt}), retrying: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  logger.warn(`AI request failed: ${lastError?.message ?? 'unknown error'}`);
  throw lastError ?? new AiError('The AI request failed.');
}

export const AI_INTERNALS = { endpoint };
