import express from 'express';
import mongoose from 'mongoose';
import { getOllamaStatus, streamOllamaChat, resolveOllamaModel } from '../services/ollamaService.js';
import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { optionalAuth } from '../middleware/authMiddleware.js';

const router = express.Router();

/**
 * GET /api/health
 */
router.get('/health', async (req, res) => {
  const status = await getOllamaStatus();
  res.json({
    status: 'online',
    ollama: status,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/models
 * Returns all installed models from local Ollama
 */
router.get('/models', async (req, res) => {
  const status = await getOllamaStatus();
  res.json({
    models: status.models.map((m) => ({
      id: m.name,
      name: m.name,
      size: m.size,
      digest: m.digest,
      details: m.details,
    })),
    activeModel: status.defaultModel,
  });
});

/**
 * POST /api/chat
 * Streams Ollama response via SSE and persists messages user-wise
 */
router.post('/chat', optionalAuth, async (req, res) => {
  const { messages, model, systemPrompt, temperature, conversationId, userMessageContent, attachments, webSearchUsed } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required' });
  }

  const resolvedModel = await resolveOllamaModel(model || 'llama3.2');

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  let accumulatedResponse = '';
  let isClosed = false;

  req.on('close', () => {
    isClosed = true;
  });

  // If user is authenticated, persist user message to MongoDB
  let convDoc = null;
  if (req.user) {
    try {
      if (conversationId && mongoose.Types.ObjectId.isValid(conversationId)) {
        convDoc = await Conversation.findOne({ _id: conversationId, userId: req.user._id });
      }

      if (!convDoc) {
        const titleSnippet = (userMessageContent || messages[messages.length - 1]?.content || 'New Conversation').slice(0, 48);
        convDoc = await Conversation.create({
          userId: req.user._id,
          title: titleSnippet,
          preview: titleSnippet,
          modelId: resolvedModel,
          modelName: resolvedModel.includes('qwen') ? 'Qwen 3 (4B Local)' : 'Llama 3.2 (3B Local)',
        });
      }

      // Save user message
      const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
      if (lastUserMsg) {
        await Message.create({
          conversationId: convDoc._id,
          userId: req.user._id,
          role: 'user',
          content: userMessageContent || lastUserMsg.content || '',
          modelId: resolvedModel,
          attachments: attachments || [],
          webSearchUsed: Boolean(webSearchUsed),
          status: 'complete',
        });
      }
    } catch (saveErr) {
      console.error('Error saving user message to MongoDB:', saveErr);
    }
  }

  const onChunk = (contentChunk) => {
    if (isClosed) return;
    accumulatedResponse += contentChunk;
    res.write('data: ' + JSON.stringify({ token: contentChunk, done: false }) + '\n\n');
    if (typeof res.flush === 'function') {
      res.flush();
    }
  };

  const onDone = async (meta) => {
    if (isClosed) return;
    // If authenticated, persist assistant message to MongoDB
    if (req.user && convDoc && accumulatedResponse.trim()) {
      try {
        await Message.create({
          conversationId: convDoc._id,
          userId: req.user._id,
          role: 'assistant',
          content: accumulatedResponse,
          modelId: resolvedModel,
          status: 'complete',
          webSearchUsed: Boolean(webSearchUsed),
        });

        // Update conversation messageCount, model, and preview
        convDoc.preview = accumulatedResponse.slice(0, 80);
        convDoc.modelId = resolvedModel;
        convDoc.messageCount = (convDoc.messageCount || 0) + 2;
        await convDoc.save();
      } catch (err) {
        console.error('Error saving assistant message to MongoDB:', err);
      }
    }

    res.write('data: ' + JSON.stringify({ token: '', done: true, meta, conversationId: convDoc?._id?.toString() }) + '\n\n');
    if (typeof res.flush === 'function') {
      res.flush();
    }
    res.end();
  };

  const onError = (err) => {
    if (isClosed) return;
    console.error('Streaming error:', err);
    res.write('data: ' + JSON.stringify({ error: err.message || 'Error from Ollama', done: true }) + '\n\n');
    if (typeof res.flush === 'function') {
      res.flush();
    }
    res.end();
  };

  await streamOllamaChat(
    { messages, model: resolvedModel, systemPrompt, temperature },
    onChunk,
    onDone,
    onError
  );
});

export default router;
