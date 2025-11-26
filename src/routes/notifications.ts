import { Elysia, t } from "elysia";
import { auth } from "../auth";
import { connectToDatabase } from "../db/connect";
import { ObjectId } from "mongodb";

const SubscriptionSchema = t.Object({
  id: t.String(),
  eventType: t.String(),
  methods: t.Array(t.Union([t.Literal("email"), t.Literal("push")])),
  createdAt: t.Date(),
});

const SubscriptionResponseSchema = t.Array(SubscriptionSchema);

type NotificationSubscription = {
  eventType: string;
  methods: ("email" | "push")[];
  createdAt: Date;
};

const SubscribeRequestSchema = t.Object({
  eventType: t.String(),
  methods: t.Array(t.Union([t.Literal("email"), t.Literal("push")])),
});

const PushSubscriptionSchema = t.Object({
  endpoint: t.String(),
  keys: t.Object({
    p256dh: t.String(),
    auth: t.String(),
  }),
});

const RegisterPushRequestSchema = t.Object({
  pushSubscription: PushSubscriptionSchema,
});

const UnsubscribeRequestSchema = t.Object({
  eventType: t.String(),
});

// Database connection for routes
const { userCollection } = await connectToDatabase();

export const notificationsRoutes = new Elysia({ prefix: "/notifications" })
  .derive(async ({ request: { headers } }) => {
    const session = await auth.api.getSession({ headers }).catch(() => null);
    return { currentUser: session?.user };
  })
  .get(
    "/subscriptions",
    async ({ currentUser }) => {
      if (!currentUser) {
        throw new Error("User not authenticated");
      }

      const user = await userCollection.findOne({
        _id: new ObjectId(currentUser.id),
      });

      if (!user) {
        throw new Error("User not found");
      }

      return (user.notificationSubscriptions || []).map(
        (sub: any, index: number) => ({
          id: `${currentUser.id}-${index}`,
          eventType: sub.eventType,
          methods: sub.methods,
          createdAt: sub.createdAt,
        })
      );
    },
    {
      response: SubscriptionResponseSchema,
      detail: {
        summary: "Get user's notification subscriptions",
        tags: ["notifications"],
        description:
          "Retrieves all notification subscriptions for the current user.",
        security: [{ session: [] }],
      },
    }
  )
  .post(
    "/subscribe",
    async ({ body, currentUser }) => {
      if (!currentUser) {
        throw new Error("User not authenticated");
      }

      // Check if email is verified
      if (!currentUser.emailVerified) {
        throw new Error("Email must be verified to subscribe to notifications");
      }

      const { eventType, methods } = body;

      const user = await userCollection.findOne({
        _id: new ObjectId(currentUser.id),
      });

      if (!user) {
        throw new Error("User not found");
      }

      // Ensure notificationSubscriptions array exists
      if (!user.notificationSubscriptions) {
        await userCollection.updateOne(
          { _id: new ObjectId(currentUser.id) },
          { $set: { notificationSubscriptions: [] } }
        );
        user.notificationSubscriptions = [];
      }

      // Type the subscriptions
      const subscriptions: NotificationSubscription[] =
        user.notificationSubscriptions;

      // Check if subscription already exists for this eventType
      const existingIndex = subscriptions.findIndex(
        (sub) => sub.eventType === eventType
      );

      const newSubscription: NotificationSubscription = {
        eventType,
        methods: [...new Set(methods)], // Ensure unique methods
        createdAt: new Date(),
      };

      if (existingIndex >= 0) {
        // Update existing subscription
        if (
          subscriptions[existingIndex].methods.length !==
            newSubscription.methods.length ||
          subscriptions[existingIndex].methods.some(
            (m) => !newSubscription.methods.includes(m)
          ) ||
          newSubscription.methods.some(
            (m) => !subscriptions[existingIndex].methods.includes(m)
          )
        ) {
          subscriptions[existingIndex] = newSubscription;
          await userCollection.updateOne(
            { _id: new ObjectId(currentUser.id) },
            {
              $set: {
                notificationSubscriptions: subscriptions,
              },
            }
          );
          return { message: "Subscription updated successfully" };
        }
        return { message: "Already subscribed with same methods" };
      }

      // Add new subscription
      subscriptions.push(newSubscription);
      await userCollection.updateOne(
        { _id: new ObjectId(currentUser.id) },
        { $set: { notificationSubscriptions: subscriptions } }
      );
      return { message: "Subscribed successfully" };
    },
    {
      body: SubscribeRequestSchema,
      response: t.Object({
        message: t.String(),
      }),
      detail: {
        summary: "Subscribe to notifications",
        tags: ["notifications"],
        description:
          "Subscribe to a notification event type with specified methods.",
        security: [{ session: [] }],
      },
    }
  )
  .post(
    "/unsubscribe",
    async ({ body, currentUser }) => {
      if (!currentUser) {
        throw new Error("User not authenticated");
      }

      const { eventType } = body;

      const user = await userCollection.findOne({
        _id: new ObjectId(currentUser.id),
      });

      if (!user?.notificationSubscriptions) {
        return { message: "No subscriptions found" };
      }

      const filteredSubscriptions = user.notificationSubscriptions.filter(
        (sub: any) => sub.eventType !== eventType
      );

      if (
        filteredSubscriptions.length === user.notificationSubscriptions.length
      ) {
        return { message: "No subscription found to unsubscribe" };
      }

      await userCollection.updateOne(
        { _id: new ObjectId(currentUser.id) },
        { $set: { notificationSubscriptions: filteredSubscriptions } }
      );

      return { message: "Unsubscribed successfully" };
    },
    {
      body: UnsubscribeRequestSchema,
      response: t.Object({
        message: t.String(),
      }),
      detail: {
        summary: "Unsubscribe from notifications",
        tags: ["notifications"],
        description: "Unsubscribe from a notification event type.",
        security: [{ session: [] }],
      },
    }
  )
  .post(
    "/register-push",
    async ({ body, currentUser }) => {
      if (!currentUser) {
        throw new Error("User not authenticated");
      }

      const { pushSubscription } = body;

      // Get user's current push subscriptions
      const user = await userCollection.findOne({
        _id: new ObjectId(currentUser.id),
      });

      if (!user) {
        throw new Error("User not found");
      }

      // Initialize pushSubscriptions array if it doesn't exist
      let pushSubscriptions = user.pushSubscriptions || [];

      // Check if this endpoint already exists
      const existingIndex = pushSubscriptions.findIndex(
        (sub: any) => sub.endpoint === pushSubscription.endpoint
      );

      if (existingIndex >= 0) {
        // Update existing subscription
        pushSubscriptions[existingIndex] = pushSubscription;
      } else {
        // Add new subscription
        pushSubscriptions.push(pushSubscription);
      }

      // Update user document
      await userCollection.updateOne(
        { _id: new ObjectId(currentUser.id) },
        { $set: { pushSubscriptions } }
      );

      return { message: "Push subscription registered successfully" };
    },
    {
      body: RegisterPushRequestSchema,
      response: t.Object({
        message: t.String(),
      }),
      detail: {
        summary: "Register push notification subscription",
        tags: ["notifications"],
        description:
          "Register a browser push notification subscription to receive push notifications.",
        security: [{ session: [] }],
      },
    }
  )
  .onError(({ error: err, set }) => {
    if (err instanceof Error) {
      if (err.message === "User not authenticated") {
        set.status = 401;
        return { message: "User not authenticated" };
      }
      if (
        err.message === "Email must be verified to subscribe to notifications"
      ) {
        set.status = 403;
        return { message: err.message };
      }
      console.error("Unhandled error:", err.message);
    }
    set.status = 500;
    return { message: "Internal server error" };
  });
