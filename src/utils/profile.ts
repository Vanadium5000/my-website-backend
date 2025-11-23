import { connectToDatabase, UserDocument } from "../db/connect";
import { Collection, ObjectId } from "mongodb";
import { PublicUser } from "../routes/profile";
import { sendNotification } from "./notifications";

// Use an async IIFE to handle getting the user collection
let userCollection: Collection<UserDocument>;
(async () => {
  const connection = await connectToDatabase();
  userCollection = connection.userCollection;
})();

// Allowed attributes for leaderboards (whitelist for security)
export const ALLOWED_LEADERBOARD_ATTRIBUTES: Array<keyof PublicUser> = [
  "age",
  "chessWins",
  "chessLosses",
  "draughtsWins",
  "draughtsLosses",
  "name",
  "arithmeticScore",
  "tetrisScore",
];

/**
 * Get public user data by user ID
 */
export async function getPublicUser(userId: string): Promise<PublicUser> {
  let parsedUserId: ObjectId;
  try {
    parsedUserId = new ObjectId(userId);
  } catch (error) {
    throw new Error("Invalid user ID format");
  }

  const user = await userCollection.findOne({ _id: parsedUserId });

  if (!user) {
    throw new Error("User not found");
  }

  // New verification system: use verified fields for public display
  let verifiedName = user.verifiedName;
  let isNewUser = false;
  if (!verifiedName) {
    // If not set, generate anonymous name and set in database
    verifiedName = generateAnonymousName(user._id.toString());
    await userCollection.updateOne(
      { _id: parsedUserId },
      { $set: { verifiedName } }
    );
    isNewUser = true;
  }

  // Send user sign up notification for new users
  if (isNewUser) {
    sendNotification("user_sign_up", {
      triggeringUserId: userId,
      cooldown: false, // Send immediately without cooldown
    }).catch((error) => {
      console.error("Error sending user sign up notification:", error);
    });
  }

  const isVerified = !!verifiedName && !verifiedName.startsWith("Anon");

  // Process a user's image & verifiedImage to upload it to the backend if not a relative path

  try {
    if (
      user.image &&
      typeof user.image === "string" &&
      !user.image.startsWith("/")
    ) {
      console.log(
        `🔄 Processing external profile image for user ${userId} during profile fetch: ${user.image}`
      );
      const { downloadAndUploadImage } = await import("../routes/images");
      const result = await downloadAndUploadImage(userId, user.image);

      // Update image field to the local URL
      const updateResult = await userCollection.updateOne(
        { _id: parsedUserId },
        {
          $set: {
            image: result.url,
          },
        }
      );
      console.log(`Database update result:`, updateResult);

      console.log(
        `✅ Profile image processed and updated during fetch: ${result.url}`
      );
    } else if (
      user.verifiedImage &&
      typeof user.verifiedImage === "string" &&
      !user.verifiedImage.startsWith("/")
    ) {
      console.log(
        `🔄 Processing external profile verified image for user ${userId} during profile fetch: ${user.verifiedImage}`
      );
      const { downloadAndUploadImage } = await import("../routes/images");
      const result = await downloadAndUploadImage(userId, user.verifiedImage);

      // Update verifiedImage field to the local URL
      const updateResult = await userCollection.updateOne(
        { _id: parsedUserId },
        {
          $set: {
            verifiedImage: result.url,
          },
        }
      );
      console.log(`Database update result:`, updateResult);

      console.log(
        `✅ Profile verified image processed and updated during fetch: ${result.url}`
      );

      // Use the new URL
      user.verifiedImage = result.url;
    }
  } catch (error) {
    console.error(
      `❌ Failed to process profile image during fetch for user ${userId}:`,
      error
    );
  }

  const result: any = {
    id: user._id.toString(),
    name: verifiedName,
    image: user.verifiedImage || null,
    isVerified,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    age: user.age || null,
    chessWins: user.chessWins || 0,
    chessLosses: user.chessLosses || 0,
    draughtsWins: user.draughtsWins || 0,
    draughtsLosses: user.draughtsLosses || 0,
    arithmeticScore: user.arithmeticScore || 0,
    tetrisScore: user.tetrisScore || 0,
  };

  // Add ban fields if present
  if (user.banned !== undefined) {
    result.banned = user.banned;
  }
  if (user.banReason !== undefined) {
    result.banReason = user.banReason;
  }
  if (user.banExpires !== undefined) {
    result.banExpires = user.banExpires;
  }

  return result;
}

/**
 * Generate anonymous name in format "AnonNNNNNN" where N is random integer
 */
function generateAnonymousName(userId: string): string {
  // Use part of userId to generate consistent random integers
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) & 0xffffffff;
  }
  const randomNum = Math.abs(hash % 90000000) + 10000000; // 8-digit number
  return `Anon${randomNum}`;
}

/**
 * Get ranked list of public users by attribute
 */
export async function getLeaderboards(
  attribute: string
): Promise<PublicUser[]> {
  if (!ALLOWED_LEADERBOARD_ATTRIBUTES.includes(attribute as any)) {
    throw new Error("Invalid attribute name for leaderboard");
  }

  // Build filter for non-null, non-zero, non-empty values
  const filter: any = {
    [attribute]: { $exists: true },
  };

  // For numeric fields, exclude 0 if it's meaningless (like wins/losses, but age could be 0)
  const numericFields: Array<keyof PublicUser> = [
    "age",
    "chessWins",
    "chessLosses",
    "draughtsWins",
    "draughtsLosses",
    "arithmeticScore",
    "tetrisScore",
  ];
  if (numericFields.includes(attribute as any)) {
    filter[attribute].$ne = 0;
  } else {
    // For strings (like name), exclude empty strings
    filter[attribute].$ne = "";
  }

  const users = await userCollection.find(filter).toArray();

  if (users.length === 0) {
    throw new Error("No profiles found with the specified attribute");
  }

  // Map to PublicUser
  const publicUsers = await Promise.all(
    users.map((user) => getPublicUser(user._id.toString()))
  );

  // Sort descending
  publicUsers.sort((a, b) => {
    const aVal = (a as any)[attribute];
    const bVal = (b as any)[attribute];

    // Handle nulls: treat as smallest
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;

    if (typeof aVal === "number" && typeof bVal === "number") {
      return bVal - aVal;
    }

    if (typeof aVal === "string" && typeof bVal === "string") {
      return bVal.localeCompare(aVal);
    }

    // For other types, convert to string
    return String(bVal).localeCompare(String(aVal));
  });

  return publicUsers;
}

/**
 * Update user stats after a game.
 * Increments the appropriate win/loss counter and initializes the opposite counter to 0 if not already set.
 */
export async function updateUserStats(
  userId: string,
  game: "chess" | "draughts",
  result: "win" | "loss"
): Promise<void> {
  const id = new ObjectId(userId);

  const winField = game === "chess" ? "chessWins" : "draughtsWins";
  const lossField = game === "chess" ? "chessLosses" : "draughtsLosses";

  const incField = result === "win" ? winField : lossField;
  const oppField = result === "win" ? lossField : winField;

  await userCollection.updateOne({ _id: id }, [
    {
      $set: {
        [incField]: {
          $add: [{ $ifNull: [`$${incField}`, 0] }, 1],
        },
        [oppField]: { $ifNull: [`$${oppField}`, 0] },
      },
    },
  ]);
}

/**
 * Update a user's high score for a specific field if the new score is higher.
 */
export async function updateHighScore(
  userId: string,
  newScore: number,
  field: string
): Promise<void> {
  const id = new ObjectId(userId);

  await userCollection.updateOne({ _id: id }, { $max: { [field]: newScore } });
}
