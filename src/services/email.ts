import { env } from "../config";

/**
 * Transactional email sender for password-reset links, via Resend.
 *
 * Follows the same shape as the FCM service (services/fcm.ts): the `resend`
 * client is lazy-loaded and memoized, and the whole thing is a no-op when
 * RESEND_API_KEY is unset — so dev/test need no credentials and the dependency
 * is only touched when an email is actually sent.
 */

export interface EmailResult {
  sent: boolean;
  skipped?: string; // reason when not sent (email disabled)
  id?: string;
  error?: string;
}

let clientPromise: Promise<any | null> | null = null;

/** Resolves the Resend client, or null when email is not configured. */
function getClient(): Promise<any | null> {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    if (!env.RESEND_API_KEY) return null;
    // Cast to `any` so tsc doesn't require the `resend` types to be present to typecheck the rest
    // of the codebase; at runtime this is a normal dynamic import of "resend".
    const mod: any = await import("resend" as any);
    const Resend = mod.Resend ?? mod.default?.Resend ?? mod.default;
    return new Resend(env.RESEND_API_KEY);
  })();

  return clientPromise;
}

/** True when email credentials are configured (send calls will actually dispatch). */
export function isEmailEnabled(): boolean {
  return Boolean(env.RESEND_API_KEY);
}

/** Sends a password-reset email containing the one-time reset link. */
export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<EmailResult> {
  const client = await getClient();
  if (!client) return { sent: false, skipped: "email_disabled" };

  const text =
    `We received a request to reset your Fuel Tracker UK password.\n\n` +
    `Reset it here (the link expires in 1 hour):\n${resetUrl}\n\n` +
    `If you didn't request this, you can safely ignore this email — your password won't change.`;

  const html =
    `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;color:#111">` +
    `<h2 style="font-size:18px;margin:0 0 12px">Reset your Fuel Tracker UK password</h2>` +
    `<p style="font-size:14px;line-height:1.5;margin:0 0 20px">` +
    `We received a request to reset your password. Click the button below to choose a new one. ` +
    `This link expires in 1 hour.</p>` +
    `<p style="margin:0 0 24px"><a href="${resetUrl}" ` +
    `style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;` +
    `padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">Reset password</a></p>` +
    `<p style="font-size:12px;line-height:1.5;color:#666;margin:0 0 8px">` +
    `Or paste this link into your browser:<br><span style="word-break:break-all">${resetUrl}</span></p>` +
    `<p style="font-size:12px;line-height:1.5;color:#666;margin:16px 0 0">` +
    `If you didn't request this, you can safely ignore this email — your password won't change.</p>` +
    `</div>`;

  try {
    const { data, error } = await client.emails.send({
      from: env.EMAIL_FROM,
      to,
      subject: "Reset your Fuel Tracker UK password",
      text,
      html,
    });
    if (error) return { sent: false, error: error.message ?? String(error) };
    return { sent: true, id: data?.id };
  } catch (err: any) {
    return { sent: false, error: err.message };
  }
}
