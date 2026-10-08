import sgMail from '@sendgrid/mail';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.SENDGRID_API_KEY;
if (apiKey) {
  sgMail.setApiKey(apiKey);
}

const isProduction = process.env.NODE_ENV === 'production';
const FROM_EMAIL = process.env.EMAIL_FROM || process.env.GMAIL_USER || process.env.SMTP_USER || 'no-reply@at-ai.com';

// Nodemailer SMTP transporter
const createSmtpTransporter = () => {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;
  const user = (process.env.SMTP_USER || process.env.GMAIL_USER || '').trim();
  const pass = (process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');

  if (host && user && pass) {
    return nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
  }

  // Fallback to Gmail service if host isn't set but user/pass exist
  if (user && pass) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
  }

  return null;
};

/**
 * Sends OTP Email for user signup verification
 */
export const sendOtpEmail = async (toEmail, otp, userName = 'Valued User') => {
  const mailOptions = {
    from: `"AT AI" <${FROM_EMAIL}>`,
    to: toEmail,
    subject: 'AT AI - Account Verification Code (OTP)',
    html: `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; padding: 28px; max-width: 580px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #4F46E5; margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -0.5px;">✨ AT AI</h1>
          <p style="color: #64748B; font-size: 14px; margin-top: 4px;">Next-Gen Intelligence Workspace</p>
        </div>
        
        <h2 style="color: #1E293B; font-size: 20px; font-weight: 700; margin-top: 0;">Verify Your Account</h2>
        <p style="color: #475569; font-size: 15px; line-height: 1.6;">Hello <strong>${userName}</strong>,</p>
        <p style="color: #475569; font-size: 15px; line-height: 1.6;">Thank you for registering with AT AI. Please use the verification code below to verify your email address and activate your account:</p>
        
        <div style="background: linear-gradient(135deg, #EEF2FF 0%, #E0E7FF 100%); text-align: center; padding: 20px; font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #4338CA; margin: 24px 0; border-radius: 12px; border: 1px dashed #6366F1;">
          ${otp}
        </div>
        
        <p style="color: #64748B; font-size: 13px; line-height: 1.5;">⏱️ <strong>This OTP is valid for 15 minutes.</strong> If you did not create an account with AT AI, please disregard this message.</p>
        
        <hr style="border: none; border-top: 1px solid #E2E8F0; margin: 24px 0;" />
        <p style="text-align: center; color: #94A3B8; font-size: 12px; margin: 0;">© ${new Date().getFullYear()} AT AI Team. All rights reserved.</p>
      </div>
    `
  };

  // 1. Try Nodemailer if SMTP configured
  const smtp = createSmtpTransporter();
  if (smtp) {
    try {
      const info = await smtp.sendMail(mailOptions);
      console.log(`[EmailService:SMTP] OTP email sent to ${toEmail}: ${info.messageId}`);
      return { success: true, messageId: info.messageId };
    } catch (smtpErr) {
      console.error('[EmailService:SMTP Error]:', smtpErr.message);
    }
  }

  // 2. Try SendGrid
  if (apiKey) {
    try {
      const [response] = await sgMail.send(mailOptions);
      const messageId = response?.headers?.['x-message-id'];
      console.log(`[EmailService:SendGrid] OTP email sent to ${toEmail}${messageId ? `: ${messageId}` : ''}`);
      return { success: true, messageId };
    } catch (error) {
      const errorBody = error.response?.body;
      const isCreditLimit = JSON.stringify(errorBody || '').includes('credits exceeded') || error.code === 401;
      
      if (isCreditLimit) {
        console.warn(`⚠️ [SendGrid Notice] The SendGrid API key has reached its maximum sending credit limit.`);
      } else {
        console.error(`[EmailService Error] Failed to send OTP to ${toEmail}:`, error.message);
      }
    }
  }

  if (isProduction) {
    console.error(`❌ [EmailService] Production email delivery failed. Ensure SMTP_USER/SMTP_PASS or SENDGRID_API_KEY is configured.`);
    return { success: false, error: 'Failed to deliver verification email. Please contact support or check mail configuration.' };
  }

  console.log(`🔑 [DEV / FALLBACK OTP for ${toEmail}]: ${otp}`);
  return { success: true, devMode: true, otp };
};

/**
 * Sends Password Reset OTP Email
 */
export const sendPasswordResetOtpEmail = async (toEmail, otp, userName = 'User') => {
  const mailOptions = {
    from: `"AT AI" <${FROM_EMAIL}>`,
    to: toEmail,
    subject: 'AT AI - Password Reset Request',
    html: `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; padding: 28px; max-width: 580px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px;">
        <h2 style="color: #1E293B; font-size: 20px; font-weight: 700;">Reset Your Password</h2>
        <p style="color: #475569; font-size: 15px;">Hello <strong>${userName}</strong>,</p>
        <p style="color: #475569; font-size: 15px;">We received a request to reset your password. Use the verification code below:</p>
        <div style="background: #FEF3C7; text-align: center; padding: 20px; font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #D97706; margin: 24px 0; border-radius: 12px; border: 1px dashed #F59E0B;">
          ${otp}
        </div>
        <p style="color: #64748B; font-size: 13px;">This code is valid for 15 minutes.</p>
        <hr style="border: none; border-top: 1px solid #E2E8F0; margin: 24px 0;" />
        <p style="text-align: center; color: #94A3B8; font-size: 12px; margin: 0;">© ${new Date().getFullYear()} AT AI Team.</p>
      </div>
    `
  };

  const smtp = createSmtpTransporter();
  if (smtp) {
    try {
      await smtp.sendMail(mailOptions);
      return { success: true };
    } catch (e) {
      console.error('[EmailService:SMTP Reset Error]:', e.message);
    }
  }

  if (apiKey) {
    try {
      await sgMail.send(mailOptions);
      return { success: true };
    } catch (error) {
      console.error('[EmailService Error]:', error.message);
    }
  }

  if (isProduction) {
    return { success: false, error: 'Failed to deliver password reset email.' };
  }

  console.log(`🔑 [DEV RESET OTP for ${toEmail}]: ${otp}`);
  return { success: true, devMode: true, otp };
};

/**
 * Sends Welcome Confirmation Email
 */
export const sendRegistrationSuccessEmail = async (toEmail, userName) => {
  const mailOptions = {
    from: `"AT AI" <${FROM_EMAIL}>`,
    to: toEmail,
    subject: 'Welcome to AT AI! 🎉 Your Account is Verified',
    html: `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; padding: 28px; max-width: 580px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px;">
        <h2 style="color: #10B981; font-size: 20px; font-weight: 700;">Account Verified! 🎉</h2>
        <p style="color: #475569; font-size: 15px;">Welcome aboard, <strong>${userName}</strong>!</p>
        <p style="color: #475569; font-size: 15px;">Your AT AI workspace is fully unlocked.</p>
        <hr style="border: none; border-top: 1px solid #E2E8F0; margin: 24px 0;" />
        <p style="text-align: center; color: #94A3B8; font-size: 12px; margin: 0;">© ${new Date().getFullYear()} AT AI Team.</p>
      </div>
    `
  };

  const smtp = createSmtpTransporter();
  if (smtp) {
    try {
      await smtp.sendMail(mailOptions);
      return { success: true };
    } catch (e) {}
  }

  if (apiKey) {
    try {
      await sgMail.send(mailOptions);
    } catch (e) {}
  }
  return { success: true };
};
