import { Elysia, t } from "elysia";
import { getPublicUser, updateHighScore } from "../utils/profile";
import { auth } from "../auth";
import { connectToDatabase, UserDocument } from "../db/connect";
import { Collection, ObjectId } from "mongodb";

export const PublicUserSchema = t.Object({
  id: t.String(),
  name: t.String(), // This will now be the verifiedName with fallback
  image: t.Nullable(t.String()), // This will now be the verifiedImage with fallback
  isVerified: t.Boolean(),
  createdAt: t.Date(),
  updatedAt: t.Date(),
  age: t.Nullable(t.Number()),
  chessWins: t.Nullable(t.Number()),
  chessLosses: t.Nullable(t.Number()),
  draughtsWins: t.Nullable(t.Number()),
  draughtsLosses: t.Nullable(t.Number()),
  arithmeticScore: t.Nullable(t.Number()),
  tetrisScore: t.Nullable(t.Number()),
  banned: t.Optional(t.Nullable(t.Boolean())),
  banReason: t.Optional(t.Nullable(t.String())),
  banExpires: t.Optional(t.Nullable(t.Date())),
});

// Derive the TS type
export type PublicUser = (typeof PublicUserSchema)["static"];

// For comparing defaultSettings & receivedSettings
function deepEqual(obj1: any, obj2: any) {
  // Check if both are null or undefined
  if (obj1 === obj2) return true;

  // Check if one is null/undefined and the other isn't
  if (obj1 == null || obj2 == null) return false;

  // Check if both are objects (including arrays)
  if (typeof obj1 !== "object" || typeof obj2 !== "object") {
    return obj1 === obj2; // Primitives
  }

  // Check if both are arrays
  if (Array.isArray(obj1) !== Array.isArray(obj2)) return false;

  // Get keys for comparison
  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);

  // Check key count
  if (keys1.length !== keys2.length) return false;

  // Recurse on each key
  for (let key of keys1) {
    if (!keys2.includes(key) || !deepEqual(obj1[key], obj2[key])) {
      return false;
    }
  }

  return true;
}

export const profileRoutes = new Elysia({ prefix: "/profile" })
  .derive(async ({ request: { headers } }) => {
    const session = await auth.api.getSession({ headers }).catch(() => null);
    return { currentUser: session?.user };
  })
  .onError(({ error: err, set }) => {
    if (err instanceof Error) {
      if (err.message === "Invalid user ID format") {
        set.status = 400;
        return { message: "Invalid user ID format" };
      }
      if (err.message === "User not found") {
        set.status = 404;
        return { message: "User not found" };
      }
      if (err.message === "User not authenticated") {
        set.status = 401;
        return { message: "User not authenticated" };
      }
      console.error("Unhandled error:", err.message);
    }
    set.status = 500;
    return { message: "Internal server error" };
  })
  .get(
    "/:userId",
    async ({ params: { userId } }) => {
      return await getPublicUser(userId);
    },
    {
      params: t.Object({
        userId: t.String({
          description: "User ID to fetch profile for",
        }),
      }),
      response: PublicUserSchema,
      detail: {
        summary: "Get public user profile by user ID",
        tags: ["profile"],
        description:
          "Retrieves publicly available user information including name, age, and game statistics.",
      },
    }
  )
  .post(
    "/log-arithmetic",
    async ({ body, currentUser }) => {
      if (!currentUser) {
        throw new Error("User not authenticated");
      }

      const { finalScore, ...receivedSettings } = body;
      const defaultSettings = {
        additionRange: {
          min1: 2,
          max1: 100,
          min2: 2,
          max2: 100,
        },
        multiplicationRange: {
          min1: 2,
          max1: 12,
          min2: 2,
          max2: 100,
        },
        duration: 120,
      };

      if (!deepEqual(defaultSettings, receivedSettings)) {
        console.log(
          `Arithmetic high score did not have default settings for ${currentUser.name}`
        );
        return {
          counted: false,
          message:
            "Your settings were not the default settings, not counted to high score",
        };
      }

      console.log(`Arithmetic high score updated for ${currentUser.name}`);
      await updateHighScore(currentUser.id, finalScore, "arithmeticScore");

      return { counted: true, message: "Score logged" };
    },

    {
      body: t.Object({
        additionRange: t.Object({
          min1: t.Number(),
          max1: t.Number(),
          min2: t.Number(),
          max2: t.Number(),
        }),
        multiplicationRange: t.Object({
          min1: t.Number(),
          max1: t.Number(),
          min2: t.Number(),
          max2: t.Number(),
        }),
        duration: t.Number(),
        finalScore: t.Number(),
      }),
      response: t.Object({
        counted: t.Boolean(),
        message: t.String(),
      }),
      detail: {
        summary: "Log arithmetic score",
        tags: ["profile"],
        description: "Log arithmetic score",
        security: [{ session: [] }],
      },
    }
  )
  .post(
    "/log-tetris",
    async ({ body, currentUser }) => {
      if (!currentUser) {
        throw new Error("User not authenticated");
      }

      let finalScore = body.finalScore;

      console.log(`Tetris high score updated for ${currentUser.name}`);
      await updateHighScore(currentUser.id, finalScore, "tetrisScore");

      return { message: "Score logged" };
    },
    {
      body: t.Object({
        finalScore: t.Number(),
      }),
      response: t.Object({
        message: t.String(),
      }),
      detail: {
        summary: "Log Tetris score",
        tags: ["profile"],
        description: "Log Tetris score",
        security: [{ session: [] }],
      },
    }
  )
  .model({ PublicUser: PublicUserSchema });

// Database connection for admin routes
// Use an async IIFE to handle getting the user collection
let userCollection: Collection<UserDocument>;
(async () => {
  const connection = await connectToDatabase();
  userCollection = connection.userCollection;
})();

const UnverifiedProfileSchema = t.Object({
  id: t.String(),
  name: t.String(),
  image: t.Nullable(t.String()),
  verifiedName: t.Nullable(t.String()),
  verifiedImage: t.Nullable(t.String()),
  needsVerification: t.Boolean(),
});

export const adminProfileRoutes = new Elysia({ prefix: "/admin/profile" })
  .derive(async ({ request: { headers } }) => {
    const session = await auth.api.getSession({ headers });
    if (!session) {
      throw new Error("Unauthorized");
    }
    if (!session.user.role?.includes("admin")) {
      throw new Error("Forbidden: Admin access required");
    }
    return { currentUser: session.user };
  })
  .onError(({ error: err, set }) => {
    if (err instanceof Error) {
      if (err.message === "Unauthorized") {
        set.status = 401;
        return { message: "Unauthorized: Admin access required" };
      }
      if (err.message === "Forbidden: Admin access required") {
        set.status = 403;
        return { message: "Forbidden: Admin access required" };
      }
      if (err.message === "User not found") {
        set.status = 404;
        return { message: "User not found" };
      }
      console.error("Unhandled error:", err.message);
    }
    set.status = 500;
    return { message: "Internal server error" };
  })
  .get(
    "/unverified",
    async () => {
      const users = await userCollection.find({}).toArray();

      const unverifiedProfiles = users
        .filter((user) => {
          // Normalize falsy values (null/undefined) to null for consistent comparison
          const normVerifiedName = user.verifiedName || null;
          const normName = user.name || null;
          const nameMismatch = normVerifiedName !== normName;

          const normVerifiedImage = user.verifiedImage || null;
          const normImage = user.image || null;
          const iconMismatch = normVerifiedImage !== normImage;

          return nameMismatch || iconMismatch;
        })
        .map((user) => ({
          id: user._id.toString(),
          name: user.name || "Unknown",
          image: user.image || null,
          verifiedName: user.verifiedName || null,
          verifiedImage: user.verifiedImage || null,
          needsVerification: true,
        }));

      return unverifiedProfiles;
    },
    {
      response: t.Array(UnverifiedProfileSchema),
      detail: {
        summary: "Get list of profiles that need verification",
        description:
          "Lists profiles where verifiedName != name or verifiedImage != image",
        tags: ["admin", "profile"],
        security: [{ session: [] }],
      },
    }
  )
  .post(
    "/:userId/verify",
    async ({ params: { userId } }) => {
      const userIdObj = new ObjectId(userId);
      const user = await userCollection.findOne({ _id: userIdObj });

      if (!user) {
        throw new Error("User not found");
      }

      // Set verified fields to current values
      await userCollection.updateOne(
        { _id: userIdObj },
        {
          $set: {
            verifiedName: user.name,
            verifiedImage: user.image || null,
          },
        }
      );

      return {
        success: true,
        message: "Profile verification accepted",
        verifiedName: user.name || "Unknown",
        verifiedImage: user.image || null,
      };
    },
    {
      params: t.Object({
        userId: t.String({
          description: "User ID to verify",
        }),
      }),
      response: t.Object({
        success: t.Boolean(),
        message: t.String(),
        verifiedName: t.String(),
        verifiedImage: t.Nullable(t.String()),
      }),
      detail: {
        summary: "Accept profile verification for a user",
        description:
          "Sets verifiedName to the current name and verifiedImage to the current icon",
        tags: ["admin", "profile"],
        security: [{ session: [] }],
      },
    }
  )
  .model({
    UnverifiedProfile: UnverifiedProfileSchema,
  });
