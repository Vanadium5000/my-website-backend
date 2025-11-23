// Backend: src/index.ts (main entry point with Socket.IO CORS added)

import { Elysia } from "elysia";
import { connectToDatabase } from "./db/connect";
import { openapi } from "@elysiajs/openapi";
import { cors } from "@elysiajs/cors";
import { Server } from "socket.io";
import { Server as Engine } from "@socket.io/bun-engine";

import { auth, OpenAPI } from "./auth";
import { setupChess } from "./webhooks/chess"; // Modularized chess logic
import { setupConnections } from "./webhooks/connections"; // Modularized connections logic
import { setupQuizspire } from "./webhooks/quizspire"; // Modularized quizspire logic
import { websocket, engine } from "./webhooks/index"; // Boilerplate/objects
import { avatarRoutes } from "./routes/avatar";
import { blogRoutes } from "./routes/blog";
import { imageRoutes } from "./routes/images";
import { profileRoutes, adminProfileRoutes } from "./routes/profile";
import { leaderboardsRoutes } from "./routes/leaderboards";
import { connectionsRoutes } from "./routes/connections"; // Admin routes for connections
import { notificationsRoutes } from "./routes/notifications";
import { quizspireRoutes } from "./routes/quizspire";
import { rateLimit } from "elysia-rate-limit";
import { ip } from "elysia-ip";

async function main() {
  const app = new Elysia()
    // Derive IP early (adds { ip } to context)
    .use(ip())
    .use(
      rateLimit({
        duration: 60_000, // 1 minute window
        max: 200, // 200 reqs per window
        generator: (req, server, { ip }) => ip, // Custom generator as getting IP on BunJS is different
      })
    ) // Global: 100 reqs/min per IP
    .use(
      openapi({
        documentation: {
          components: await OpenAPI.components,
          paths: await OpenAPI.getPaths(),
        },
      })
    )
    .use(
      cors({
        origin: process.env.CORS_ORIGINS
          ? process.env.CORS_ORIGINS.split(",")
          : ["http://localhost:5173"], // Allow requests from your frontend
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], // Allow specific HTTP methods
        allowedHeaders: ["Content-Type", "Authorization"], // Allow specific headers
        credentials: true, // Allow cookies or credentials if needed
      })
    )
    .mount("/", auth.handler)
    .use(avatarRoutes) // Mounts the avatar routes
    .use(blogRoutes) // Mounts the blog routes
    .use(imageRoutes) // Mounts the image routes
    .use(profileRoutes) // Mounts the profile routes
    .use(adminProfileRoutes) // Mounts the admin profile routes
    .use(leaderboardsRoutes) // Mounts the leaderboards routes
    .use(connectionsRoutes) // Mounts the connections admin routes
    .use(notificationsRoutes) // Mounts the notifications routes
    .use(quizspireRoutes) // Mounts the quizspire routes
    .get("/", () => "hi")
    .get("/me", async ({ request: { headers } }) => {
      return await auth.api.getSession({ headers });
    });
  const io = new Server({
    cors: {
      origin: "http://localhost:5173",
      credentials: true,
    },
  });
  io.bind(engine);

  setupChess(io.of("/sockets/chess")); // Set up chess handlers on /sockets/chess
  setupConnections(io.of("/sockets/connection")); // Set up connections on /sockets/connection
  setupQuizspire(io.of("/sockets/quizspire")); // Set up quizspire handlers on /sockets/quizspire

  // export default {
  //   port: parseInt(process.env.PORT || "3000"),
  //   idleTimeout: 30, // Adjust based on your needs (must exceed pingInterval)
  //   fetch(req: Request, server: any) {
  //     const url = new URL(req.url);
  //     if (url.pathname.startsWith("/sockets/")) {
  //       return engine.handleRequest(req, server);
  //     } else {
  //       return app.handle(req); // Elysia handles non-Socket.IO requests
  //     }
  //   },
  //   websocket,
  // };

  console.log(`🦊 Elysia is running at http://localhost:3000`);
  console.log(
    `📚 OpenAPI documentation available at http://localhost:3000/openapi`
  );
}

main();
