import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    password: {
      type: String,
      required: true,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    otp: {
      type: String,
      default: null,
    },
    otpExpiresAt: {
      type: Date,
      default: null,
    },
    avatar: {
      type: String,
      default: '',
    },
    plan: {
      type: String,
      default: 'Pro',
    },
    tokensUsed: {
      type: Number,
      default: 0,
    },
    tokenLimit: {
      type: Number,
      default: 500000,
    },
  },
  { timestamps: true }
);

export const User = mongoose.model('User', userSchema);
