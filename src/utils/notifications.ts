import { connectToDatabase, UserDocument } from "../db/connect";
import { Collection, ObjectId } from "mongodb";
import { sendEmail } from "./email";
import {
  sendNotificationEvent,
  NotificationEventData,
} from "../routes/connections";
import webpush from "web-push";

// Configure web-push
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY as string;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY as string;
const vapidSubject = process.env.VAPID_SUBJECT as string;

if (vapidPublicKey && vapidPrivateKey && vapidSubject) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
}

// Use an async IIFE to handle getting the user collection
let userCollection: Collection<UserDocument>;
(async () => {
  const connection = await connectToDatabase();
  userCollection = connection.userCollection;
})();

// Cooldown map: eventType -> lastSentTime
const notificationCooldowns = new Map<string, number>();
const EMAIL_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes
const BROWSER_PUSH_COOLDOWN_MS = 30 * 1000; // 30 seconds

function getEventMessage(eventType: string, userName?: string): string {
  const verifiedName = userName || "A user";

  switch (eventType) {
    case "chess_match_created":
      return "A new chess match is available! Join now to play.";
    case "user_sign_up":
      return `${verifiedName} just signed up! Welcome to the platform.`;
    default:
      return `${verifiedName} triggered a new event: ${eventType}`;
  }
}

// Generic function to send push notification to user push subscriptions
export async function sendBrowserPush(
  pushSubscriptions: any[],
  message: string,
  userId: string,
  tag?: string
) {
  if (!pushSubscriptions?.length) return;

  const validSubscriptions: any[] = [];

  for (const pushSub of pushSubscriptions) {
    if (!pushSub?.keys?.p256dh || !pushSub?.keys?.auth || !pushSub?.endpoint) {
      console.warn(`Invalid push subscription for user ${userId}, skipping`);
      continue;
    }

    try {
      const result = await webpush.sendNotification(
        {
          endpoint: pushSub.endpoint,
          keys: {
            p256dh: pushSub.keys.p256dh,
            auth: pushSub.keys.auth,
          },
        },
        JSON.stringify({
          title: "Platform Notification",
          body: message,
          tag,
          // icon: "/favicon.ico", // Adjust as needed
        })
      );
      console.log(
        `Sent push notification to user ${userId}: result ${
          result?.statusCode || result
        }`
      );
      // If successful, keep the subscription
      validSubscriptions.push(pushSub);
    } catch (error) {
      console.error(
        `Failed to send push notification to user ${userId}:`,
        error
      );
      // Do not add to validSubscriptions, effectively removing it
    }
  }

  // Update the user's pushSubscriptions in the database if any were removed
  if (validSubscriptions.length !== pushSubscriptions.length) {
    await userCollection.updateOne(
      { _id: new ObjectId(userId) },
      { $set: { pushSubscriptions: validSubscriptions } }
    );
    console.log(
      `Removed ${
        pushSubscriptions.length - validSubscriptions.length
      } invalid push subscriptions for user ${userId}`
    );
  }
}

// Generic function to send notification for an event
export async function sendNotification(
  eventType: string,
  options?: {
    triggeringUserId?: string; // ID of user who triggered the event (for messages)
    cooldown?: boolean; // Whether to apply cooldown (default true)
    forceSend?: boolean; // Override cooldown
  }
) {
  console.log(`Handling ${eventType} notifications`);

  // Check cooldown unless overridden
  const applyCooldown = options?.cooldown !== false;
  let isEmailEventCooldown = false;
  let isBrowserPushEventCooldown = false;
  if (applyCooldown) {
    const now = Date.now();
    const lastSent = notificationCooldowns.get(eventType);
    if (lastSent && now - lastSent < EMAIL_COOLDOWN_MS && !options?.forceSend) {
      console.log(`Notification for ${eventType} for EMAIL is on cooldown`);
      isEmailEventCooldown = true;
    } else {
      notificationCooldowns.set(eventType, now);
    }
    if (
      lastSent &&
      now - lastSent < BROWSER_PUSH_COOLDOWN_MS &&
      !options?.forceSend
    ) {
      console.log(
        `Notification for ${eventType} for BROWSER PUSH is on cooldown`
      );
      isBrowserPushEventCooldown = true;
    } else {
      notificationCooldowns.set(eventType, now);
    }
  }

  // Get triggering user's verified name if needed
  let triggeringUserName: string | undefined;
  if (options?.triggeringUserId) {
    const triggeringUser = await userCollection.findOne({
      _id: new ObjectId(options.triggeringUserId),
    });
    triggeringUserName =
      triggeringUser?.verifiedName || triggeringUser?.name || undefined;
  }

  const message = getEventMessage(eventType, triggeringUserName);
  const notificationUserIds: string[] = []; // User IDs to send websocket notifications to
  const emailPromises: Promise<void>[] = [];
  const pushPromises: Promise<void>[] = [];

  // Get all users with notifications enabled for this event
  const users = await userCollection
    .find({
      notificationSubscriptions: {
        $elemMatch: {
          eventType,
          methods: { $exists: true },
        },
      },
    })
    .toArray();

  for (const user of users) {
    // Skip if user is banned or email not verified
    if (user.banned || !user.emailVerified) continue;

    const subscription = user.notificationSubscriptions?.find(
      (sub: any) => sub.eventType === eventType
    );
    if (!subscription?.methods?.length) continue;

    // Handle email notifications
    if (
      subscription.methods.includes("email") &&
      user.email &&
      !isEmailEventCooldown
    ) {
      emailPromises.push(
        sendEmail({
          to: user.email,
          subject: "Platform Notification",
          text: message,
        }).catch((error) => {
          console.error(`Failed to send email to ${user.email}:`, error);
        })
      );
    }

    // Collect for websocket notifications
    notificationUserIds.push(user._id.toString());

    // Handle push notifications
    if (
      subscription.methods.includes("push") &&
      user.pushSubscriptions?.length &&
      !isBrowserPushEventCooldown
    ) {
      pushPromises.push(
        sendBrowserPush(
          user.pushSubscriptions,
          message,
          user._id.toString(),
          eventType
        )
      );
    }
  }

  // Execute all notifications concurrently
  await Promise.allSettled([
    ...emailPromises,
    ...pushPromises,
    ...(notificationUserIds.length > 0
      ? [
          (async () => {
            const notificationData: NotificationEventData = {
              type: "info",
              text: message,
              time: 6000,
            };
            const sentCount = sendNotificationEvent(
              notificationUserIds,
              "notification",
              notificationData
            );
            console.log(
              `Sent websocket notification to ${notificationUserIds.length} users: ${sentCount} sockets`
            );
          })(),
        ]
      : []),
  ]);
}
