import mongoose from 'mongoose';

const conversationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      default: 'New Conversation',
      trim: true,
    },
    preview: {
      type: String,
      default: '',
    },
    modelId: {
      type: String,
      default: 'llama3.2',
    },
    modelName: {
      type: String,
      default: 'Llama 3.2',
    },
    isPinned: {
      type: Boolean,
      default: false,
    },
    tags: {
      type: [String],
      default: [],
    },
    messageCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

export const Conversation = mongoose.model('Conversation', conversationSchema);
