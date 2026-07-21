import { readFileSync } from "fs";
import { env } from "../config";

/**
 * Firebase Cloud Messaging sender for price-drop push notifications.
 *
 * The backend previously only *stored* device tokens (User.fcmToken) — nothing
 * sent anything. This wires up the actual send path used by the fuel-admin
 * console (test pushes + the price-drop run).
 *
 * `firebase-admin` is lazy-loaded and the whole thing is a no-op when
 * FIREBASE_SERVICE_ACCOUNT is unset, so dev/test need no credentials and the
 * dependency is only touched when notifications are actually used.
 */

export interface PriceDropPayload {
  stationId: number;
  stationName: string;
  fuelType: string;
  pricePence: number;
}

export interface SendResult {
  sent: boolean;
  skipped?: string; // reason when not sent (no token / FCM disabled)
  messageId?: string;
  error?: string;
}

let messagingPromise: Promise<any | null> | null = null;

/** Resolves the FCM messaging instance, or null when FCM is not configured. */
function getMessaging(): Promise<any | null> {
  if (messagingPromise) return messagingPromise;

  messagingPromise = (async () => {
    if (!env.FIREBASE_SERVICE_ACCOUNT) return null;

    // Accept either an inline JSON string or a path to the JSON file.
    const raw = env.FIREBASE_SERVICE_ACCOUNT.trim();
    let credentialJson: any;
    try {
      credentialJson = raw.startsWith("{") ? JSON.parse(raw) : JSON.parse(readFileSync(raw, "utf8"));
    } catch (err: any) {
      console.error("[FCM] Failed to load FIREBASE_SERVICE_ACCOUNT:", err.message);
      return null;
    }

    // Specifier cast to `any` so tsc doesn't require the (heavy, prod-only)
    // firebase-admin types to be present to typecheck the rest of the codebase.
    // At runtime this is a normal dynamic import of "firebase-admin".
    const mod: any = await import("firebase-admin" as any);
    const admin = mod.default ?? mod;
    const app = admin.apps.length
      ? admin.apps[0]
      : admin.initializeApp({ credential: admin.credential.cert(credentialJson) });
    return admin.messaging(app);
  })();

  return messagingPromise;
}

/** True when FCM credentials are configured (send calls will actually dispatch). */
export function isFcmEnabled(): boolean {
  return Boolean(env.FIREBASE_SERVICE_ACCOUNT);
}

/**
 * Sends a price-drop notification to a single device token. The data payload
 * matches what the Android client's FcmService expects (snake_case keys).
 */
export async function sendPriceDropNotification(
  fcmToken: string | null | undefined,
  payload: PriceDropPayload
): Promise<SendResult> {
  if (!fcmToken) return { sent: false, skipped: "no_token" };

  const messaging = await getMessaging();
  if (!messaging) return { sent: false, skipped: "fcm_disabled" };

  try {
    const messageId = await messaging.send({
      token: fcmToken,
      notification: {
        title: payload.stationName,
        body: `${payload.fuelType} now ${payload.pricePence.toFixed(1)}p`,
      },
      data: {
        station_id: String(payload.stationId),
        station_name: payload.stationName,
        fuel_type: payload.fuelType,
        price_pence: String(payload.pricePence),
      },
      android: { priority: "high" },
    });
    return { sent: true, messageId };
  } catch (err: any) {
    return { sent: false, error: err.message };
  }
}
