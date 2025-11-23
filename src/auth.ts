import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { openAPI, admin } from "better-auth/plugins";
import { connectToDatabase } from "./db/connect";
import { sendEmail } from "./utils/email";

// Use an async IIFE to handle the connection
let db;
(async () => {
  const connection = await connectToDatabase();
  db = connection.db;
})();

export const auth = betterAuth({
  // baseURL: "http://localhost:3000/auth/api", // Your app's root URL (update for production)
  basePath: "/auth/api", // Matches your mounting; defaults to "/api/auth" otherwise
  database: mongodbAdapter(db!),
  plugins: [openAPI(), admin()],
  trustedOrigins: ["http://localhost:5173", "https://my-website.space"],
  user: {
    deleteUser: {
      enabled: true,
    },
    additionalFields: {
      // Example custom fields – add as many as needed
      age: {
        type: "number",
        required: false,
      },
      chessWins: {
        type: "number",
        required: false,
      },
      chessLosses: {
        type: "number",
        required: false,
      },
      draughtsWins: {
        type: "number",
        required: false,
      },
      draughtsLosses: {
        type: "number",
        required: false,
      },
      arithmeticScore: {
        type: "number",
        required: false,
      },
      tetrisScore: {
        type: "number",
        required: false,
      },
      // Profile verification system fields
      verifiedName: {
        type: "string",
        required: false,
      },
      verifiedImage: {
        type: "string",
        required: false,
      },
      // Ban fields from admin plugin
      banned: {
        type: "boolean",
        required: false,
      },
      banReason: {
        type: "string",
        required: false,
      },
      banExpires: {
        type: "date",
        required: false,
      },
      // Image upload tracking
      imagesStoredSize: {
        type: "number",
        required: false,
        default: 0,
      },
      lastUploadDay: {
        type: "string", // ISO date string YYYY-MM-DD
        required: false,
      },
      imagesUploadedToday: {
        type: "number",
        required: false,
        default: 0,
      },
      pushSubscriptions: {
        type: "json",
        required: false,
      },
      notificationSubscriptions: {
        type: "json",
        required: false,
      },
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Verify your email address",
        text: `Click the link to verify your email: ${url}`,
      });
    },
    // sendOnSignUp: true, // Callback doesn't work
  },
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      // Explicitly set to match your full mounted callback
      // redirectURI: "http://localhost:3000/auth/api/callback/google",
    },
    twitter: {
      clientId: process.env.TWITTER_CLIENT_ID as string,
      clientSecret: process.env.TWITTER_CLIENT_SECRET as string,
    },
  },
});

let _schema: ReturnType<typeof auth.api.generateOpenAPISchema>;
const getSchema = async () => (_schema ??= auth.api.generateOpenAPISchema());

export const OpenAPI = {
  getPaths: (prefix = "/auth/api") =>
    getSchema().then(({ paths }) => {
      const reference: typeof paths = Object.create(null);
      for (const path of Object.keys(paths)) {
        const key = prefix + path;
        reference[key] = paths[path];
        for (const method of Object.keys(paths[path])) {
          const operation = (reference[key] as any)[method];
          operation.tags = ["Better Auth"];
        }
      }
      return reference;
    }) as Promise<any>,
  components: getSchema().then(({ components }) => components) as Promise<any>,
} as const;
