import express from 'express';
import mongoose from 'mongoose';
import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = express.Router();

// All conversation routes are user-scoped
router.use(requireAuth);

/**
 * GET /api/conversations
 * Get all conversations for current user
 */
router.get('/', async (req, res) => {
  try {
    const conversations = await Conversation.find({ userId: req.user._id })
      .sort({ updatedAt: -1 })
      .lean();

    const formatted = conversations.map((c) => ({
      id: c._id.toString(),
      title: c.title,
      preview: c.preview || '',
      modelId: c.modelId || 'llama3.2',
      modelName: c.modelName || 'Llama 3.2',
      isPinned: Boolean(c.isPinned),
      tags: c.tags || [],
      messageCount: c.messageCount || 0,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));

    res.json(formatted);
  } catch (err) {
    console.error('Fetch conversations error:', err);
    res.status(500).json({ error: 'Failed to fetch conversations.' });
  }
});

/**
 * POST /api/conversations
 * Create a new conversation
 */
router.post('/', async (req, res) => {
  try {
    const { id, title, preview, modelId, modelName, isPinned, tags } = req.body;

    const convData = {
      userId: req.user._id,
      title: title || 'New Conversation',
      preview: preview || '',
      modelId: modelId || 'llama3.2',
      modelName: modelName || 'Llama 3.2',
      isPinned: Boolean(isPinned),
      tags: tags || [],
    };

    if (id && mongoose.Types.ObjectId.isValid(id)) {
      convData._id = id;
    }

    const conv = await Conversation.create(convData);

    res.status(201).json({
      id: conv._id.toString(),
      title: conv.title,
      preview: conv.preview,
      modelId: conv.modelId,
      modelName: conv.modelName,
      isPinned: conv.isPinned,
      tags: conv.tags,
      messageCount: 0,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    });
  } catch (err) {
    console.error('Create conversation error:', err);
    res.status(500).json({ error: 'Failed to create conversation.' });
  }
});

/**
 * GET /api/conversations/:id/messages
 * Get all messages for a specific conversation
 */
router.get('/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.json([]);
    }

    const messages = await Message.find({
      conversationId: id,
      userId: req.user._id,
    })
      .sort({ createdAt: 1 })
      .lean();

    const formatted = messages.map((m) => ({
      id: m._id.toString(),
      conversationId: m.conversationId.toString(),
      role: m.role,
      content: m.content,
      modelId: m.modelId,
      modelName: m.modelName,
      status: m.status || 'complete',
      thinking: m.thinking,
      isLiked: Boolean(m.isLiked),
      isDisliked: Boolean(m.isDisliked),
      webSearchUsed: Boolean(m.webSearchUsed),
      attachments: m.attachments || [],
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));

    res.json(formatted);
  } catch (err) {
    console.error('Fetch messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages.' });
  }
});

/**
 * PUT /api/conversations/:id
 * Rename / update conversation
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, isPinned, preview } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    const conv = await Conversation.findOne({ _id: id, userId: req.user._id });
    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    if (title !== undefined) conv.title = title;
    if (isPinned !== undefined) conv.isPinned = isPinned;
    if (preview !== undefined) conv.preview = preview;

    await conv.save();

    res.json({
      id: conv._id.toString(),
      title: conv.title,
      preview: conv.preview,
      modelId: conv.modelId,
      modelName: conv.modelName,
      isPinned: conv.isPinned,
      tags: conv.tags,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    });
  } catch (err) {
    console.error('Update conversation error:', err);
    res.status(500).json({ error: 'Failed to update conversation.' });
  }
});

/**
 * DELETE /api/conversations/:id
 * Delete conversation and its messages
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (mongoose.Types.ObjectId.isValid(id)) {
      await Message.deleteMany({ conversationId: id, userId: req.user._id });
      await Conversation.deleteOne({ _id: id, userId: req.user._id });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete conversation error:', err);
    res.status(500).json({ error: 'Failed to delete conversation.' });
  }
});

/**
 * DELETE /api/conversations
 * Clear all conversations for user
 */
router.delete('/', async (req, res) => {
  try {
    await Message.deleteMany({ userId: req.user._id });
    await Conversation.deleteMany({ userId: req.user._id });
    res.json({ success: true });
  } catch (err) {
    console.error('Clear conversations error:', err);
    res.status(500).json({ error: 'Failed to clear conversations.' });
  }
});

export default router;
