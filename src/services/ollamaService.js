import dotenv from 'dotenv';
dotenv.config();

let runtimeOllamaUrl = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
const DEFAULT_MODEL = (process.env.DEFAULT_MODEL || 'llama3.2').trim();

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
 * Tests connection to any Ollama / Cloudflare Tunnel URL
 */
export async function testOllamaConnection(targetUrl) {
  const normalizedUrl = normalizeOllamaUrl(targetUrl);
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

  try {
    const res = await fetch(`${normalizedUrl}/api/tags`, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
      },
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
 * Resolves frontend model ID to the exact local Ollama model tag
 */
export async function resolveOllamaModel(requestedModel, customUrl) {
  const status = await getOllamaStatus(customUrl);
  if (!status.connected || !status.models || status.models.length === 0) {
    return requestedModel || DEFAULT_MODEL;
  }

  const installedNames = status.models.map((m) => m.name);

  // Exact match (e.g. "qwen3:4b", "llama3.2:latest")
  if (installedNames.includes(requestedModel)) {
    return requestedModel;
  }

  // Suffix match (e.g. requested "llama3.2" matches "llama3.2:latest")
  const withLatest = `${requestedModel}:latest`;
  if (installedNames.includes(withLatest)) {
    return withLatest;
  }

  // Prefix match (e.g. "llama3.2" matches "llama3.2:3b" or "llama3.2:latest")
  const prefixMatch = installedNames.find((name) =>
    name.startsWith(requestedModel + ':') || name.startsWith(requestedModel)
  );
  if (prefixMatch) {
    return prefixMatch;
  }

  // Base name match
  const baseRequested = requestedModel.split(':')[0].toLowerCase();
  const baseMatch = installedNames.find((name) =>
    name.split(':')[0].toLowerCase() === baseRequested
  );
  if (baseMatch) {
    return baseMatch;
  }

  // Return requestedModel as-is
  return requestedModel || DEFAULT_MODEL;
}

/**
 * Streams chat responses from local or tunnelled Ollama model
 */
export async function streamOllamaChat(
  { messages, model = DEFAULT_MODEL, systemPrompt, temperature = 0.7, customUrl },
  onChunk,
  onDone,
  onError
) {
  const targetBaseUrl = getActiveOllamaUrl(customUrl);

  try {
    const resolvedModel = await resolveOllamaModel(model, targetBaseUrl);
    console.log(`[Ollama] Routing chat request via [${targetBaseUrl}] to model: ${resolvedModel} (requested: ${model})`);

    const formattedMessages = [];
    let hasImages = false;

    if (systemPrompt && systemPrompt.trim()) {
      formattedMessages.push({ role: 'system', content: systemPrompt.trim() });
    }

    for (const msg of messages) {
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
      formattedMessages.push(formattedMsg);
    }

    const payload = {
      model: resolvedModel,
      messages: formattedMessages,
      stream: true,
      options: {
        temperature: Number(temperature) || 0.7,
      },
    };

    const response = await fetch(`${targetBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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
            onChunk(parsed.message.content);
          }
          if (parsed.done) {
            onDone(parsed);
            return;
          }
        } catch (e) {
          // ignore partial JSON parse
        }
      }
    }

    onDone({ done: true });
  } catch (err) {
    onError(err);
  }
}
