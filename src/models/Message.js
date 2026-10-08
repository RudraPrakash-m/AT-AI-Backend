import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ['user', 'assistant', 'system'],
      required: true,
    },
    content: {
      type: String,
      default: '',
    },
    modelId: {
      type: String,
    },
    modelName: {
      type: String,
    },
    status: {
      type: String,
      enum: ['sending', 'streaming', 'complete', 'error'],
      default: 'complete',
    },
    thinking: {
      type: String,
    },
    isLiked: {
      type: Boolean,
      default: false,
    },
    isDisliked: {
      type: Boolean,
      default: false,
    },
    webSearchUsed: {
      type: Boolean,
      default: false,
    },
    attachments: [
      {
        id: String,
        name: String,
        size: Number,
        type: { type: String },
        url: String,
        base64: String,
        textContent: String,
      },
    ],
  },
  { timestamps: true }
);

export const Message = mongoose.model('Message', messageSchema);
