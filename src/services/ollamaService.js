import dotenv from 'dotenv';
import http from 'http';
import https from 'https';
dotenv.config();

let runtimeOllamaUrl = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
const DEFAULT_MODEL = (process.env.DEFAULT_MODEL || 'llama3.2').trim();

// 1. Persistent HTTP/HTTPS Keep-Alive Agents for Low Latency Connection Pooling
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 60000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 60000 });

// 2. High-Speed In-Memory LRU Response Cache (Caches deterministic / identical queries)
const RESPONSE_CACHE = new Map();
const MAX_CACHE_SIZE = 100;

function getCacheKey(model, messages, systemPrompt) {
  if (messages.length > 2) return null; // Only cache quick standard questions/queries
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'user' || typeof lastMsg.content !== 'string') return null;
  return `${model}:::${(systemPrompt || '').slice(0, 40)}:::${lastMsg.content.trim().toLowerCase()}`;
}

function getFromCache(key) {
  if (!key || !RESPONSE_CACHE.has(key)) return null;
  const item = RESPONSE_CACHE.get(key);
  if (Date.now() - item.timestamp > 1000 * 60 * 30) { // 30 min TTL
    RESPONSE_CACHE.delete(key);
    return null;
  }
  return item.response;
}

function setInCache(key, response) {
  if (!key || !response || response.length > 3000) return;
  if (RESPONSE_CACHE.size >= MAX_CACHE_SIZE) {
    const firstKey = RESPONSE_CACHE.keys().next().value;
    if (firstKey) RESPONSE_CACHE.delete(firstKey);
  }
  RESPONSE_CACHE.set(key, { response, timestamp: Date.now() });
}

// Default high-performance system prompt
const DEFAULT_SYSTEM_PROMPT = 
  'You are AT AI, a helpful, intelligent, and precise AI assistant. ' +
  'Provide well-structured, concise, and accurate explanations. ' +
  'Use proper Markdown formatting with specific language identifiers in all code blocks.';

/**
 * Normalizes URL and strips trailing slashes
 */
export function normalizeOllamaUrl(url) {
  if (!url || typeof url !== 'string' || !url.trim()) {
    return runtimeOllamaUrl || 'http://127.0.0.1:11434';
  }
  let clean = url.trim();
  if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
    clean = `https://${clean}`;
  }
  return clean.replace(/\/+$/, '');
}

/**
 * Gets the current active runtime Ollama URL
 */
export function getActiveOllamaUrl(customUrl) {
  return normalizeOllamaUrl(customUrl || runtimeOllamaUrl);
}

/**
 * Updates the global fallback runtime Ollama URL
 */
export function setRuntimeOllamaUrl(newUrl) {
  if (newUrl && typeof newUrl === 'string' && newUrl.trim()) {
    runtimeOllamaUrl = normalizeOllamaUrl(newUrl);
  }
  return runtimeOllamaUrl;
}

/**
 * Tests connection to any Ollama / Cloudflare Tunnel URL with low-latency agent
 */
export async function testOllamaConnection(targetUrl) {
  const normalizedUrl = normalizeOllamaUrl(targetUrl);
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

  try {
    const isHttps = normalizedUrl.startsWith('https://');
    const res = await fetch(`${normalizedUrl}/api/tags`, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
      },
      // @ts-ignore
      agent: isHttps ? httpsAgent : httpAgent,
    });
    clearTimeout(timeoutId);

    const latencyMs = Date.now() - startTime;

    if (!res.ok) {
      return {
        connected: false,
        url: normalizedUrl,
        latencyMs,
        error: `Ollama endpoint returned HTTP status ${res.status} (${res.statusText})`,
        models: [],
        defaultModel: DEFAULT_MODEL,
      };
    }

    const data = await res.json();
    return {
      connected: true,
      url: normalizedUrl,
      latencyMs,
      models: data.models || [],
      defaultModel: DEFAULT_MODEL,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;
    const isTimeout = err.name === 'AbortError';
    return {
      connected: false,
      url: normalizedUrl,
      latencyMs,
      error: isTimeout
        ? 'Connection timed out after 8s. Check if your Cloudflare Tunnel is active.'
        : (err.message || 'Unable to connect to Ollama / Cloudflare endpoint.'),
      models: [],
      defaultModel: DEFAULT_MODEL,
    };
  }
}

/**
 * Fetches models and connection status for given customUrl or active runtime URL
 */
export async function getOllamaStatus(customUrl) {
  const target = getActiveOllamaUrl(customUrl);
  return testOllamaConnection(target);
}

/**
 * Resolves frontend model ID to the exact local Ollama model tag with auto-fallback
 */
export async function resolveOllamaModel(requestedModel, customUrl) {
  const status = await getOllamaStatus(customUrl);
  if (!status.connected || !status.models || status.models.length === 0) {
    return requestedModel || DEFAULT_MODEL;
  }

  const installedNames = status.models.map((m) => m.name);

  // 1. Exact match (e.g. "qwen3:4b", "llama3.2:latest")
  if (installedNames.includes(requestedModel)) {
    return requestedModel;
  }

  // 2. Suffix match (e.g. requested "llama3.2" matches "llama3.2:latest")
  const withLatest = `${requestedModel}:latest`;
  if (installedNames.includes(withLatest)) {
    return withLatest;
  }

  // 3. Prefix match (e.g. "llama3.2" matches "llama3.2:3b" or "llama3.2:latest")
  const prefixMatch = installedNames.find((name) =>
    name.startsWith(requestedModel + ':') || name.startsWith(requestedModel)
  );
  if (prefixMatch) {
    return prefixMatch;
  }

  // 4. Base name match
  const baseRequested = requestedModel.split(':')[0].toLowerCase();
  const baseMatch = installedNames.find((name) =>
    name.split(':')[0].toLowerCase() === baseRequested
  );
  if (baseMatch) {
    return baseMatch;
  }

  // 5. Intelligent Fallback to any installed local model
  if (installedNames.length > 0) {
    const fallback = installedNames.find(m => m.includes('llama') || m.includes('qwen') || m.includes('deepseek')) || installedNames[0];
    console.log(`[Ollama] Model '${requestedModel}' not found. Falling back to installed model '${fallback}'`);
    return fallback;
  }

  return requestedModel || DEFAULT_MODEL;
}

/**
 * Smart Context Windowing: Truncates and budgets long message histories to keep prompt evaluation fast
 */
function prepareContextMessages(messages, systemPrompt) {
  const formatted = [];
  let hasImages = false;

  // Add system prompt
  const effectiveSystemPrompt = (systemPrompt && systemPrompt.trim()) ? systemPrompt.trim() : DEFAULT_SYSTEM_PROMPT;
  formatted.push({ role: 'system', content: effectiveSystemPrompt });

  // If chat is very long, keep the first message + rolling last 12 messages to prevent token bloat
  const MAX_HISTORY_TURNS = 14;
  let sliced = messages;
  if (messages.length > MAX_HISTORY_TURNS) {
    sliced = [messages[0], ...messages.slice(-MAX_HISTORY_TURNS + 1)];
  }

  for (const msg of sliced) {
    const formattedMsg = {
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content || '',
    };
    if (Array.isArray(msg.images) && msg.images.length > 0) {
      hasImages = true;
      formattedMsg.images = msg.images.map((img) =>
        typeof img === 'string' && img.includes(',') ? img.split(',')[1] : img
      );
    }
    formatted.push(formattedMsg);
  }

  return { formattedMessages: formatted, hasImages };
}

/**
 * Streams chat responses from local or tunnelled Ollama model with low latency and keep-alive
 */
export async function streamOllamaChat(
  { messages, model = DEFAULT_MODEL, systemPrompt, temperature = 0.7, customUrl },
  onChunk,
  onDone,
  onError
) {
  const targetBaseUrl = getActiveOllamaUrl(customUrl);

  // Check LRU Cache for quick repeat questions
  const cacheKey = getCacheKey(model, messages, systemPrompt);
  const cachedResponse = getFromCache(cacheKey);
  if (cachedResponse) {
    console.log(`[Ollama Cache Hit] Returning cached response in <5ms for query.`);
    // Stream cached response in fast chunks
    const chunkSize = 24;
    for (let i = 0; i < cachedResponse.length; i += chunkSize) {
      onChunk(cachedResponse.slice(i, i + chunkSize));
    }
    onDone({ done: true, cached: true });
    return;
  }

  try {
    const resolvedModel = await resolveOllamaModel(model, targetBaseUrl);
    console.log(`[Ollama] Streaming request via [${targetBaseUrl}] to model: ${resolvedModel} (requested: ${model})`);

    const { formattedMessages, hasImages } = prepareContextMessages(messages, systemPrompt);

    // Optimized inference configuration
    const payload = {
      model: resolvedModel,
      messages: formattedMessages,
      stream: true,
      keep_alive: '15m', // Keep model in VRAM/RAM for 15 mins to eliminate cold-start overhead
      options: {
        num_ctx: 8192, // 8k token context window
        temperature: Math.max(0.1, Math.min(Number(temperature) || 0.7, 1.2)),
        top_p: 0.9,
        repeat_penalty: 1.1,
      },
    };

    const isHttps = targetBaseUrl.startsWith('https://');
    const response = await fetch(`${targetBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // @ts-ignore
      agent: isHttps ? httpsAgent : httpAgent,
    });

    if (!response.ok) {
      const errText = await response.text();
      let errorMsg = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error) {
          if (typeof parsed.error === 'string' && parsed.error.includes('{')) {
            try {
              const nested = JSON.parse(parsed.error);
              errorMsg = nested.error?.message || nested.message || parsed.error;
            } catch {
              errorMsg = parsed.error;
            }
          } else {
            errorMsg = parsed.error;
          }
        }
      } catch {
        // use raw text
      }

      if (hasImages && (errorMsg.toLowerCase().includes('multimodal') || errorMsg.toLowerCase().includes('not support'))) {
        errorMsg = '⚠️ The model (' + resolvedModel + ') is a text-only model and does not support image analysis.\n\nTo analyze images locally in Ollama:\n1. Run: `ollama pull llama3.2-vision` or `ollama pull llava` in your terminal.\n2. Select **Llama 3.2 Vision** or **LLaVA** in the model dropdown.';
      } else if (errorMsg.toLowerCase().includes('not found') || response.status === 404) {
        errorMsg = '⚠️ The model (' + resolvedModel + ') was not found in your active Ollama instance at ' + targetBaseUrl + '.\n\nTo install it, run:\n```bash\nollama pull ' + resolvedModel + '\n```';
      }

      throw new Error(errorMsg);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullResponse = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.message && parsed.message.content) {
            fullResponse += parsed.message.content;
            onChunk(parsed.message.content);
          }
          if (parsed.done) {
            if (cacheKey && fullResponse.trim()) {
              setInCache(cacheKey, fullResponse);
            }
            onDone(parsed);
            return;
          }
        } catch (e) {
          // ignore partial JSON parse
        }
      }
    }

    if (cacheKey && fullResponse.trim()) {
      setInCache(cacheKey, fullResponse);
    }
    onDone({ done: true });
  } catch (err) {
    onError(err);
  }
}
