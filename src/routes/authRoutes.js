import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';
import { sendOtpEmail, sendPasswordResetOtpEmail, sendRegistrationSuccessEmail } from '../services/emailService.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'aura_ai_jwt_secret_default_key';

function generate6DigitOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function formatUserProfile(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatar || '',
    jobTitle: user.jobTitle || '',
    organization: user.organization || '',
    bio: user.bio || '',
    ollamaBaseUrl: user.ollamaBaseUrl || '',
    plan: user.plan || 'Pro',
    tokensUsed: user.tokensUsed || 0,
    tokenLimit: user.tokenLimit || 500000,
    createdAt: user.createdAt,
  };
}

function createJwtToken(user) {
  return jwt.sign(
    {
      id: user._id,
      email: user.email,
      name: user.name,
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

/**
 * POST /api/auth/register
 * Step 1: Create unverified user, generate OTP, send verification email via SendGrid
 */
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const existingUser = await User.findOne({ email: cleanEmail });

    if (existingUser && existingUser.isVerified) {
      return res.status(400).json({ error: 'An account with this email already exists. Please log in.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const otp = generate6DigitOtp();
    const otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    let user;
    if (existingUser && !existingUser.isVerified) {
      existingUser.name = name.trim();
      existingUser.password = hashedPassword;
      existingUser.otp = otp;
      existingUser.otpExpiresAt = otpExpiresAt;
      user = await existingUser.save();
    } else {
      user = await User.create({
        name: name.trim(),
        email: cleanEmail,
        password: hashedPassword,
        isVerified: false,
        otp,
        otpExpiresAt,
      });
    }

    // Send verification email via SendGrid
    const emailResult = await sendOtpEmail(cleanEmail, otp, user.name);

    res.status(201).json({
      success: true,
      message: 'Verification code sent to your email. Please verify to continue.',
      email: cleanEmail,
      devOtp: emailResult.devMode ? otp : undefined,
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message || 'Registration failed.' });
  }
});

/**
 * POST /api/auth/verify-otp
 * Step 2: Validate 6-digit OTP, activate account, return JWT
 */
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP code are required.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: cleanEmail });

    if (!user) {
      return res.status(404).json({ error: 'User not found. Please register first.' });
    }

    if (!user.otp || user.otp !== otp.trim()) {
      return res.status(400).json({ error: 'Invalid verification code. Please check your email.' });
    }

    if (user.otpExpiresAt && new Date() > user.otpExpiresAt) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }

    user.isVerified = true;
    user.otp = null;
    user.otpExpiresAt = null;
    await user.save();

    // Send welcome email in background
    sendRegistrationSuccessEmail(cleanEmail, user.name).catch(() => {});

    const token = createJwtToken(user);

    res.json({
      success: true,
      message: 'Account verified successfully!',
      token,
      user: formatUserProfile(user),
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: err.message || 'Verification failed.' });
  }
});

/**
 * POST /api/auth/resend-otp
 * Resend verification OTP code via SendGrid
 */
router.post('/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: cleanEmail });

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const otp = generate6DigitOtp();
    user.otp = otp;
    user.otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await user.save();

    const emailResult = await sendOtpEmail(cleanEmail, otp, user.name);

    res.json({
      success: true,
      message: 'A new verification code has been sent to your email.',
      email: cleanEmail,
      devOtp: emailResult.devMode ? otp : undefined,
    });
  } catch (err) {
    console.error('Resend OTP error:', err);
    res.status(500).json({ error: err.message || 'Failed to resend verification code.' });
  }
});

/**
 * POST /api/auth/login
 * Log in with email & password
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: cleanEmail });

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Check if account is verified
    if (!user.isVerified) {
      const otp = generate6DigitOtp();
      user.otp = otp;
      user.otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await user.save();

      await sendOtpEmail(cleanEmail, otp, user.name);

      return res.status(403).json({
        requireVerification: true,
        email: cleanEmail,
        message: 'Your email address is not verified yet. A verification code has been sent to your email.',
      });
    }

    const token = createJwtToken(user);

    res.json({
      success: true,
      token,
      user: formatUserProfile(user),
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message || 'Login failed.' });
  }
});

/**
 * GET /api/auth/me or GET /api/auth/profile
 * Get current authenticated user profile details
 */
const getProfileHandler = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json({
      success: true,
      user: formatUserProfile(user),
    });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch user profile.' });
  }
};

router.get('/me', requireAuth, getProfileHandler);
router.get('/profile', requireAuth, getProfileHandler);

/**
 * PUT /api/auth/profile or PUT /api/auth/me
 * Update authenticated user profile details
 */
const updateProfileHandler = async (req, res) => {
  try {
    const { name, email, jobTitle, organization, bio, avatar, avatarUrl } = req.body;
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (name !== undefined) {
      const trimmedName = String(name).trim();
      if (!trimmedName) {
        return res.status(400).json({ error: 'Name cannot be empty.' });
      }
      user.name = trimmedName;
    }

    if (email !== undefined) {
      const trimmedEmail = String(email).toLowerCase().trim();
      if (!trimmedEmail) {
        return res.status(400).json({ error: 'Email cannot be empty.' });
      }
      if (trimmedEmail !== user.email) {
        const emailConflict = await User.findOne({ email: trimmedEmail, _id: { $ne: user._id } });
        if (emailConflict) {
          return res.status(400).json({ error: 'Email is already in use by another account.' });
        }
        user.email = trimmedEmail;
      }
    }

    if (jobTitle !== undefined) {
      user.jobTitle = String(jobTitle).trim();
    }

    if (organization !== undefined) {
      user.organization = String(organization).trim();
    }

    if (bio !== undefined) {
      user.bio = String(bio).trim();
    }

    if (req.body.ollamaBaseUrl !== undefined) {
      user.ollamaBaseUrl = String(req.body.ollamaBaseUrl).trim();
    }

    if (avatar !== undefined) {
      user.avatar = String(avatar).trim();
    } else if (avatarUrl !== undefined) {
      user.avatar = String(avatarUrl).trim();
    }

    const savedUser = await user.save();

    res.json({
      success: true,
      message: 'Profile updated successfully.',
      user: formatUserProfile(savedUser),
    });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: err.message || 'Failed to update profile.' });
  }
};

router.put('/profile', requireAuth, updateProfileHandler);
router.put('/me', requireAuth, updateProfileHandler);

/**
 * POST /api/auth/forgot-password
 */
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const cleanEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: cleanEmail });

    if (!user) {
      return res.json({ success: true, message: 'If an account exists, a reset code has been sent.' });
    }

    const otp = generate6DigitOtp();
    user.otp = otp;
    user.otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await user.save();

    await sendPasswordResetOtpEmail(cleanEmail, otp, user.name);

    res.json({ success: true, message: 'Password reset code sent to your email.', email: cleanEmail });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: err.message || 'Failed to process password reset.' });
  }
});

/**
 * POST /api/auth/reset-password
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ error: 'Email, OTP, and new password are required.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: cleanEmail });

    if (!user || user.otp !== otp.trim() || new Date() > user.otpExpiresAt) {
      return res.status(400).json({ error: 'Invalid or expired OTP code.' });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    user.otp = null;
    user.otpExpiresAt = null;
    await user.save();

    res.json({ success: true, message: 'Password has been reset successfully. You can now log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: err.message || 'Failed to reset password.' });
  }
});

export default router;
