import { Socket, Namespace } from "socket.io";
import { auth } from "../auth";
import { UserDocument } from "../db/connect";

// User document type without the "_id" field
type UserData = Omit<UserDocument, "_id"> | undefined;
export interface ConnectionRecord {
  socketId: string;
  userData: UserData;
  connectedAt: Date;
  route: string;
  socketInfo: {
    ip: string;
    userAgent?: string;
    origin?: string;
  };
}

/**
 * Active connections for /sockets/connection namespace.
 * This map tracks all connected clients, both authenticated users and anonymous users.
 * Key: socket.id, Value: ConnectionRecord
 */
export const activeConnections = new Map<string, ConnectionRecord>();

/**
 * Reference to the /sockets/connection namespace for admin actions (send events, disconnect).
 */
export let connectionsNamespace: Namespace;

/**
 * Sets up the /sockets/connection namespace.
 * Clients connect to listen for messages and events.
 * Supports both polling and websockets.
 * Authenticates users if possible, otherwise treats as anonymous.
 */
export function setupConnections(nsp: Namespace) {
  connectionsNamespace = nsp;
  nsp.on("connection", async (socket: Socket) => {
    let userData: UserData;

    try {
      // Attempt to authenticate using cookie/session
      const headers = new Headers(socket.handshake.headers as any);
      userData = (await auth.api.getSession({ headers }))?.user;
    } catch (error: any) {
      console.log(
        `Auth failed for socket ${socket.id}: ${error?.message || error}`
      );
    }

    // Record the connection
    activeConnections.set(socket.id, {
      socketId: socket.id,
      userData,
      connectedAt: new Date(),
      route: "/sockets/connection",
      socketInfo: {
        ip: socket.handshake.address,
        userAgent: socket.handshake.headers["user-agent"],
        origin: socket.handshake.headers.origin,
      },
    });

    const displayName = userData?.name;
    console.log(
      `Connection established: ${
        displayName || "anonymous"
      } on /sockets/connection`
    );

    // Notify client of successful connection and type
    socket.emit("connected", {
      message: `Connected as ${displayName || "anonymous"}`,
      connectedAt: new Date().toISOString(),
    });

    // Handle disconnect
    socket.on("disconnect", (reason) => {
      console.log(
        `Disconnect: ${displayName || "anonymous"} (${socket.id}) - ${reason}`
      );
      activeConnections.delete(socket.id);
    });

    // Future event handlers can be added here for specific messages/events
    // For example:
    // socket.on("some_event", (data) => { ... });
  });
}
