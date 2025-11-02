import { Elysia, t } from "elysia";
import {
  activeConnections,
  ConnectionRecord,
  connectionsNamespace,
} from "../webhooks/connections";
import { auth } from "../auth";

export interface NotificationEventData {
  type?: "info" | "success" | "warning" | "error";
  text: string;
  time?: number;
}

export function sendNotificationEvent(
  userIds: string[],
  event: string,
  data: NotificationEventData
): number {
  if (!userIds || userIds.length === 0 || !connectionsNamespace) {
    return 0;
  }

  let sentCount = 0;
  for (const [socketId, connection] of activeConnections.entries()) {
    if (connection.userData?.id && userIds.includes(connection.userData.id)) {
      const socket = connectionsNamespace.sockets.get(socketId);
      if (socket && socket.connected) {
        socket.emit(event, data);
        sentCount++;
      }
    }
  }
  return sentCount;
}

// HACK: I WOULD PREFER IF WE HAD AN OFFICIAL TYPE
export const UserDataSchema = t.Union([
  t.Object({
    id: t.String(),
    createdAt: t.Date(),
    updatedAt: t.Date(),
    email: t.Optional(t.Union([t.String(), t.Null()])),
    emailVerified: t.Optional(t.Union([t.Boolean(), t.Null()])),
    name: t.Optional(t.Union([t.String(), t.Null()])),
    image: t.Optional(t.Union([t.String(), t.Null()])),
    // Custom fields
    age: t.Optional(t.Union([t.Number(), t.Null()])),
    chessWins: t.Optional(t.Union([t.Number(), t.Null()])),
    chessLosses: t.Optional(t.Union([t.Number(), t.Null()])),
    draughtsWins: t.Optional(t.Union([t.Number(), t.Null()])),
    draughtsLosses: t.Optional(t.Union([t.Number(), t.Null()])),
    arithmeticScore: t.Optional(t.Union([t.Number(), t.Null()])),
    tetrisScore: t.Optional(t.Union([t.Number(), t.Null()])),
    // Verification fields
    verifiedName: t.Optional(t.Union([t.String(), t.Null()])),
    verifiedImage: t.Optional(t.Union([t.String(), t.Null()])),
    // Ban fields from admin plugin
    banned: t.Optional(t.Union([t.Boolean(), t.Null()])),
    role: t.Optional(t.Union([t.String(), t.Null()])),
    banReason: t.Optional(t.Union([t.String(), t.Null()])),
    banExpires: t.Optional(t.Union([t.Date(), t.Null()])),
    // Image upload tracking
    imagesStoredSize: t.Optional(t.Union([t.Number(), t.Null()])),
    lastUploadDay: t.Optional(t.Union([t.String(), t.Null()])),
    imagesUploadedToday: t.Optional(t.Union([t.Number(), t.Null()])),
    pushSubscriptions: t.Optional(
      t.Array(
        t.Object({
          keys: t.Object({
            p256dh: t.String(),
            auth: t.String(),
          }),
          endpoint: t.String(),
        })
      )
    ),
    notificationSubscriptions: t.Optional(
      t.Array(
        t.Object({
          eventType: t.String(),
          methods: t.Array(t.Union([t.Literal("email"), t.Literal("push")])),
          createdAt: t.Date(),
        })
      )
    ),
  }),
  t.Undefined(),
]);

const SocketInfoSchema = t.Object({
  ip: t.Optional(t.String()),
  userAgent: t.Optional(t.String()),
  origin: t.Optional(t.String()),
});

const ConnectionSchema = t.Object({
  socketId: t.String(),
  userData: UserDataSchema,
  connectedAt: t.Date(),
  route: t.String(),
  socketInfo: SocketInfoSchema,
});

const ConnectionsResponseSchema = t.Object({
  total: t.Number(),
  connections: t.Array(ConnectionSchema),
  timestamp: t.Date(),
});

export const connectionsRoutes = new Elysia({ prefix: "/connections" })
  .guard({
    beforeHandle: async ({ request: { headers } }) => {
      const session = await auth.api.getSession({ headers });
      if (!session) {
        throw new Error("Unauthorized");
      }

      if (!session.user.role?.includes("admin")) {
        throw new Error("Forbidden: Admin access required");
      }
    },
  })
  .onError(({ error: err, set }) => {
    if (err instanceof Error) {
      if (err.message === "Unauthorized") {
        set.status = 401;
        return { message: "Unauthorized: Authentication required" };
      }
      if (err.message === "Forbidden: Admin access required") {
        set.status = 403;
        return { message: "Forbidden: Admin access required" };
      }
      if (err.message === "Connection not found") {
        set.status = 404;
        return { message: "Connection not found" };
      }
      console.error("Unhandled error:", err.message);
    }
    set.status = 500;
    return { message: "Internal server error" };
  })
  .get(
    "/",
    ({}) => ({
      total: activeConnections.size,
      connections: Array.from(activeConnections.values()),
      timestamp: new Date(),
    }),
    {
      response: ConnectionsResponseSchema,
      detail: {
        summary: "List all active WebSocket connections",
        description:
          "Returns detailed information about all active connections including user data and socket info. Admin only.",
        tags: ["admin", "connections"],
        security: [{ session: [] }],
      },
    }
  )
  .post(
    "/send-event",
    ({ body: { socketId, event, data } }) => {
      if (!socketId) {
        connectionsNamespace.emit(event, data);
        return {
          success: true,
          message: "Event broadcast to all connections",
          recipients: activeConnections.size,
        };
      }

      const socket = connectionsNamespace.sockets.get(socketId);
      if (!socket) {
        throw new Error("Connection not found");
      }

      socket.emit(event, data);
      return { success: true, message: `Event sent to socket ${socketId}` };
    },
    {
      body: t.Object({
        socketId: t.Optional(t.String()),
        event: t.String(),
        data: t.Optional(t.Unknown()),
      }),
      response: t.Object({
        success: t.Boolean(),
        message: t.String(),
        recipients: t.Optional(t.Number()),
      }),
      detail: {
        summary: "Send custom event to connection(s)",
        description:
          "Send a custom WebSocket event to a specific socket (if socketId provided) or broadcast to all connections in the namespace. Admin only.",
        tags: ["admin", "connections", "events"],
        security: [{ session: [] }],
      },
    }
  )
  .post(
    "/disconnect",
    ({ body: { socketId } }) => {
      const socket = connectionsNamespace.sockets.get(socketId);
      if (!socket) {
        throw new Error("Connection not found");
      }

      socket.disconnect(true);
      activeConnections.delete(socketId);

      return { success: true, message: `Disconnected socket ${socketId}` };
    },
    {
      body: t.Object({
        socketId: t.String(),
      }),
      response: t.Object({
        success: t.Boolean(),
        message: t.String(),
      }),
      detail: {
        summary: "Force disconnect a WebSocket connection",
        description:
          "Forcefully disconnect a specific WebSocket connection. Connection will reconnect automatically if client supports reconnection. Admin only.",
        tags: ["admin", "connections", "disconnect"],
        security: [{ session: [] }],
      },
    }
  );
