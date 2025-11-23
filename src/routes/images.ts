import { Elysia, t } from "elysia";
import { connectToDatabase } from "../db/connect";
import { auth } from "../auth";
import { rateLimit } from "elysia-rate-limit";
import { ObjectId } from "mongodb";
import { Jimp } from "jimp";
import { promises as fs } from "node:fs";
import path from "node:path";

const { userCollection } = await connectToDatabase();
const usersCollection = userCollection;
const dataDir = process.env.DATA_DIR || "data";
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_COMPRESSED_SIZE = 2 * 1024 * 1024; // 2MB
const MAX_USER_STORAGE = 100 * 1024 * 1024; // 100MB
const MAX_UPLOADS_PER_DAY = 10;
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

/**
 * Reusable function to upload an image buffer to the user's directory
 */
async function uploadImage(
  userId: string,
  imageBuffer: Buffer,
  mimeType: string,
  originalFilename?: string
): Promise<{ success: boolean; imageId: string; size: number; url: string }> {
  // Validate MIME type
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new Error("Invalid file type. Only images are allowed");
  }

  // Check file size
  if (imageBuffer.length > MAX_FILE_SIZE) {
    throw new Error("Image too large. Maximum size is 5MB");
  }

  // Get current user data for quota and rate check
  await usersCollection.updateOne(
    { _id: new ObjectId(userId) },
    {
      $setOnInsert: {
        imagesStoredSize: 0,
        lastUploadDay: null,
        imagesUploadedToday: 0,
      },
    },
    { upsert: true }
  );

  const user = await usersCollection.findOne({
    _id: new ObjectId(userId),
  });

  if (!user) {
    throw new Error("Failed to initialize user data");
  }

  const today = new Date().toISOString().split("T")[0];
  const storedSize = user.imagesStoredSize || 0;
  const lastUploadDay = user.lastUploadDay;
  const uploadsToday = user.imagesUploadedToday || 0;

  if (storedSize >= MAX_USER_STORAGE) {
    throw new Error("Storage quota exceeded. Maximum 100MB total");
  }

  if (lastUploadDay === today && uploadsToday >= MAX_UPLOADS_PER_DAY) {
    throw new Error("Daily upload limit exceeded");
  }

  // Process image with Jimp
  let processedBuffer: Buffer = imageBuffer;
  const image = await Jimp.read(imageBuffer);
  let quality = 80;
  let attempt = 0;
  const maxAttempts = 10;

  do {
    processedBuffer = await image.clone().getBuffer("image/jpeg", { quality });
    if (processedBuffer.length <= MAX_COMPRESSED_SIZE) break;
    quality -= 5;
    attempt++;
  } while (quality > 10 && attempt < maxAttempts);

  if (processedBuffer.length > MAX_COMPRESSED_SIZE) {
    throw new Error("Unable to compress image under 2MB");
  }

  // Generate filename (sanitize original filename if provided)
  const timestamp = Date.now();
  const ext = "jpg"; // Always convert to jpg for simplicity
  let filename = `${userId}_${timestamp}.${ext}`;

  // Sanitize filename if provided
  if (originalFilename) {
    const originalBase = path.parse(originalFilename).name; // Remove extension
    const sanitized = originalBase.replace(/[^a-zA-Z0-9._-]/g, "_");
    filename = `${userId}_${timestamp}_${sanitized}.${ext}`;
  }

  const filepath = path.join(dataDir, "images", filename);

  // Ensure directory exists
  await fs.mkdir(path.dirname(filepath), { recursive: true });

  // Write file
  await fs.writeFile(filepath, processedBuffer);

  // Update user stats atomically
  const newSize = storedSize + processedBuffer.length;
  const newUploadsToday = lastUploadDay === today ? uploadsToday + 1 : 1;

  await usersCollection.updateOne(
    { _id: new ObjectId(userId) },
    {
      $set: {
        imagesStoredSize: newSize,
        lastUploadDay: today,
        imagesUploadedToday: newUploadsToday,
      },
    }
  );

  console.log(
    `Image uploaded for user ${userId}: ${filename}, size: ${processedBuffer.length} bytes`
  );

  return {
    success: true,
    imageId: filename,
    size: processedBuffer.length,
    url: `/images/${filename}`,
  };
}

/**
 * Download an image from an external URL and upload it locally
 */
export async function downloadAndUploadImage(
  userId: string,
  imageUrl: string
): Promise<{ success: boolean; imageId: string; size: number; url: string }> {
  // Validate URL
  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    throw new Error("Invalid URL format");
  }

  // Only allow HTTP/HTTPS
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are allowed");
  }

  // Download the image using fetch
  try {
    const response = await fetch(imageUrl, {
      headers: {
        "User-Agent": "BetterAuth-Backend/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Check content type
    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.startsWith("image/")) {
      throw new Error("URL does not point to an image");
    }

    const mimeType = contentType.split(";")[0].toLowerCase();

    // Check content length if available
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
      throw new Error("Image too large. Maximum size is 5MB");
    }

    const arrayBuffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);

    if (imageBuffer.length > MAX_FILE_SIZE) {
      throw new Error("Image too large. Maximum size is 5MB");
    }

    // Extract filename from URL for sanitization
    const pathname = url.pathname;
    const originalFilename = path.basename(pathname) || "downloaded_image";

    return await uploadImage(userId, imageBuffer, mimeType, originalFilename);
  } catch (error) {
    console.error(`Failed to download image from ${imageUrl}:`, error);
    throw new Error(`Failed to download image: ${(error as Error).message}`);
  }
}

export const imageRoutes = new Elysia({ prefix: "/images" })
  .derive(async ({ request: { headers } }) => {
    const session = await auth.api.getSession({ headers }).catch(() => null);
    return { currentUser: session?.user };
  })
  .use(
    rateLimit({
      duration: 86_400_000, // 24 hours in ms
      max: MAX_UPLOADS_PER_DAY,
      generator: async (req, server, { headers }) => {
        const session = await auth.api
          .getSession({ headers })
          .catch(() => null);
        if (!session?.user?.id) return "anonymous";
        return session.user.id;
      },
      skip: (request) => {
        const pathname = new URL(request.url).pathname;
        return !pathname.endsWith("/upload");
      },
      errorResponse: "Daily upload limit exceeded. Try again tomorrow.",
    })
  )
  .post(
    "/upload",
    async ({ body: { image }, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      if (!image) {
        set.status = 400;
        return { error: "No image provided" };
      }

      try {
        const file = await image.arrayBuffer();
        const mimeType = image.type;
        const originalFilename = image.name;
        const result = await uploadImage(
          currentUser.id,
          Buffer.from(file),
          mimeType,
          originalFilename
        );
        return result;
      } catch (error) {
        console.error("Upload error:", error);
        set.status = 400;
        return { error: (error as Error).message };
      }
    },
    {
      body: t.Object({
        image: t.File({
          maxSize: MAX_FILE_SIZE,
          description: "Image file (max 5MB)",
        }),
      }),
      response: {
        200: t.Object({
          success: t.Boolean(),
          imageId: t.String(),
          size: t.Number(),
          url: t.String(),
        }),
        400: t.Object({
          error: t.String(),
        }),
        401: t.Object({
          error: t.String(),
        }),
        429: t.Object({
          error: t.String(),
        }),
        500: t.Object({
          error: t.String(),
        }),
      },
      detail: {
        summary: "Upload an image",
        tags: ["images"],
        security: [{ session: [] }],
      },
    }
  )
  .get(
    "/",
    async ({ currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      try {
        const files = await fs.readdir(path.join(dataDir, "images"));
        const userImages = files
          .filter((f) => f.startsWith(`${currentUser.id}_`))
          .map((f) => ({
            id: f,
            filename: f,
            url: `/images/${f}`,
            uploadedAt: parseInt(f.split("_")[1].split(".")[0] || "0"),
          }))
          .sort((a, b) => b.uploadedAt - a.uploadedAt);

        return { images: userImages };
      } catch (error) {
        set.status = 500;
        return { error: "Failed to list images" };
      }
    },
    {
      response: {
        200: t.Object({
          images: t.Array(
            t.Object({
              id: t.String(),
              filename: t.String(),
              url: t.String(),
              uploadedAt: t.Number(),
            })
          ),
        }),
        401: t.Object({
          error: t.String(),
        }),
        500: t.Object({
          error: t.String(),
        }),
      },
      detail: {
        summary: "Get user's uploaded images",
        tags: ["images"],
        security: [{ session: [] }],
      },
    }
  )
  .get(
    "/:imageId",
    async ({ params: { imageId }, set }) => {
      const filepath = path.join(dataDir, "images", imageId);

      try {
        await fs.access(filepath);
        const file = Bun.file(filepath);
        return file;
      } catch {
        set.status = 404;
        return { error: "Image not found" };
      }
    },
    {
      params: t.Object({
        imageId: t.String({
          description: "Image filename (userId_timestamp.ext)",
        }),
      }),
      response: {
        200: t.Any(), // File response
        404: t.Object({
          error: t.String(),
        }),
      },
      detail: {
        summary: "Get an image file",
        description: "Serves an image file.",
        tags: ["images"],
      },
    }
  )
  .delete(
    "/:imageId",
    async ({ params: { imageId }, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      // Validate filename belongs to current user
      if (!imageId.startsWith(`${currentUser.id}_`)) {
        set.status = 403;
        return { error: "Access denied: You can only delete your own images" };
      }

      const filepath = path.join(dataDir, "images", imageId);

      try {
        // Get file stats before deleting
        const stats = await fs.stat(filepath);
        const fileSize = stats.size;

        // Delete the file
        await fs.unlink(filepath);

        // Update user's stored size
        await usersCollection.updateOne(
          { _id: new ObjectId(currentUser.id) },
          { $inc: { imagesStoredSize: -fileSize } }
        );

        console.log(
          `Image deleted for user ${currentUser.id}: ${imageId}, freed ${fileSize} bytes`
        );

        return { success: true, deleted: imageId };
      } catch (error) {
        if ((error as any).code === "ENOENT") {
          set.status = 404;
          return { error: "Image not found" };
        }
        console.error("Delete error:", error);
        set.status = 500;
        return { error: "Failed to delete image" };
      }
    },
    {
      params: t.Object({
        imageId: t.String({
          description: "Image filename to delete (userId_timestamp.ext)",
        }),
      }),
      response: {
        200: t.Object({
          success: t.Boolean(),
          deleted: t.String(),
        }),
        401: t.Object({
          error: t.String(),
        }),
        403: t.Object({
          error: t.String(),
        }),
        404: t.Object({
          error: t.String(),
        }),
        500: t.Object({
          error: t.String(),
        }),
      },
      detail: {
        summary: "Delete an uploaded image",
        description:
          "Deletes the specified image if it belongs to the authenticated user. Updates storage quota accordingly.",
        tags: ["images"],
        security: [{ session: [] }],
      },
    }
  );
