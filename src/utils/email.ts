import nodemailer from "nodemailer";

// Load environment variables for SMTP configuration
const smtpHost = process.env.SMTP_HOST as string;
const smtpPort = process.env.SMTP_PORT
  ? parseInt(process.env.SMTP_PORT, 10)
  : 587;
const smtpUser = process.env.SMTP_USER as string;
const smtpPass = process.env.SMTP_PASS as string;
const emailFrom = process.env.EMAIL_FROM as string; // Default 'from' address, e.g., 'no-reply@yourapp.com'

// Validate required env vars
if (!smtpHost) throw new Error("SMTP_HOST not set in .env");
if (!smtpUser) throw new Error("SMTP_USER not set in .env");
if (!smtpPass) throw new Error("SMTP_PASS not set in .env");
if (!emailFrom) throw new Error("EMAIL_FROM not set in .env");

// Create a reusable transporter object using SMTP transport
const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpPort === 465, // Use true for port 465 (SSL), false for other ports (TLS)
  auth: {
    user: smtpUser,
    pass: smtpPass,
  },
});

// Verify the transporter configuration (optional but recommended for initial setup)
transporter.verify((error, success) => {
  if (error) {
    console.error("SMTP connection error:", error);
  } else {
    console.log("SMTP server is ready to take messages");
  }
});

interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string; // Optional HTML version for richer emails
  from?: string; // Optional override for 'from' address
  cc?: string | string[]; // Optional CC recipients
  bcc?: string | string[]; // Optional BCC recipients
  attachments?: Array<{ filename: string; path: string }>; // Optional attachments
}

export async function sendEmail(options: SendEmailOptions): Promise<void> {
  const mailOptions = {
    from: options.from || emailFrom,
    to: options.to,
    subject: options.subject,
    text: options.text,
    html: options.html,
    cc: options.cc,
    bcc: options.bcc,
    attachments: options.attachments,
  };

  try {
    console.log(`Sending email to ${options.to}`);
    await transporter.sendMail(mailOptions);
    console.log(`Email sent successfully to ${options.to}`);
  } catch (error) {
    console.error("Error sending email:", error);
    throw new Error("Failed to send email");
  }
}
