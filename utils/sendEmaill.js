const nodemailer = require("nodemailer");

const sendResetLink = async (email, resetToken) => {
  // 1. Configure your email transporter
  // Replace these placeholders with your actual SMTP details (SendGrid, Mailgun, Gmail, Mailtrap, etc.)
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: false, // false for port 587
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });

  // 2. Define your backend routing URL where the token is sent
  const resetLink = `${process.env.RESET_BACKEND_URL}?token=${resetToken}`;
  const companyName = "AYD ask your database V2";

  // 3. Compose the HTML email template
  const mailOptions = {
    from: `"${companyName} Support"`,
    to: email,
    subject: "Reset Your Password",
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f6f9; padding: 40px 10px; margin: 0; width: 100%;">
        <div style="max-width: 500px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); overflow: hidden; border: 1px solid #e1e8ed;">
          
          <div style="background-color: #ffffff; padding: 30px 30px 10px 30px; text-align: center;">
            <h2 style="color: #1e293b; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">${companyName}</h2>
          </div>

          <div style="padding: 20px 30px 40px 30px; text-align: center;">
            <p style="color: #475569; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
              We received a request to reset your password. No changes have been made yet. You can reset your password by clicking the big blue button below.
            </p>

            <div style="margin: 30px 0;">
              <a href="${resetLink}" target="_blank" style="background-color: #2563eb; color: #ffffff; padding: 14px 28px; font-weight: 600; font-size: 16px; text-decoration: none; border-radius: 6px; display: inline-block; transition: background-color 0.2s ease; box-shadow: 0 4px 6px -1px rgba(37, 99, 235, 0.2);">
                Click to Reset Password
              </a>
            </div>

            <p style="color: #ef4444; font-size: 13px; font-weight: 500; margin: 25px 0 0 0;">
              ⚠️ This link is highly time-sensitive and will expire in 11 minutes.
            </p>
          </div>

          <div style="background-color: #f8fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #edf2f7;">
            <p style="color: #94a3b8; font-size: 12px; margin: 0 0 8px 0;">
              If you didn't request a password reset, you can safely ignore this email. Your password will remain secure.
            </p>
            <p style="color: #94a3b8; font-size: 12px; margin: 0;">
              &copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.
            </p>
          </div>

        </div>
      </div>
    `,
  };

  // 4. Fire off the email!
  // (Since your main controller uses .catch(), returning the promise lets errors bubble up naturally)
  return transporter.sendMail(mailOptions);
};

module.exports = sendResetLink;
