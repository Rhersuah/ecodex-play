// src/utils/email.js
//
// Sends real emails via SMTP. This REQUIRES your own email account
// credentials — Anthropic/Claude cannot generate a working email sender for
// you, since it's tied to your own email account or transactional email
// service. See README.md section "Email Verification Setup" for how to get
// these values.
//
// Until EMAIL_SMTP_HOST is set in .env, this module runs in "dev mode":
// instead of sending a real email, it logs the code to the server console
// AND returns it directly in the API response so you can test the full
// signup flow locally before setting up real email sending. Remove that dev
// fallback once real SMTP is configured, or new users won't be able to
// verify their email in production.
const nodemailer = require('nodemailer');

function isEmailConfigured() {
  return !!(process.env.EMAIL_SMTP_HOST && process.env.EMAIL_SMTP_USER && process.env.EMAIL_SMTP_PASS);
}

function getTransporter() {
  return nodemailer.createTransport({
    host: process.env.EMAIL_SMTP_HOST,
    port: Number(process.env.EMAIL_SMTP_PORT) || 587,
    secure: process.env.EMAIL_SMTP_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_SMTP_USER,
      pass: process.env.EMAIL_SMTP_PASS,
    },
  });
}

// Returns { sent: boolean, devCode: string|null } — devCode is only
// populated when SMTP isn't configured, so the caller can surface it for
// local testing.
async function sendVerificationEmail(toEmail, fullName, code) {
  if (!isEmailConfigured()) {
    console.log(`[DEV MODE — no SMTP configured] Verification code for ${toEmail}: ${code}`);
    return { sent: false, devCode: code };
  }

  const transporter = getTransporter();
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_SMTP_USER,
    to: toEmail,
    subject: 'Verify your E-Codex Play account',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color:#10b981;">E-Codex Play</h2>
        <p>Hi ${fullName || 'there'},</p>
        <p>Thanks for signing up. Please use the code below to verify your email address:</p>
        <div style="background:#0b0f17; color:#10b981; font-size:28px; font-weight:800; letter-spacing:6px; padding:16px; border-radius:10px; text-align:center; margin:20px 0;">${code}</div>
        <p>This code expires in 15 minutes. If you did not sign up for E-Codex Play, you can safely ignore this email.</p>
      </div>
    `,
  });
  return { sent: true, devCode: null };
}

module.exports = { isEmailConfigured, sendVerificationEmail };
