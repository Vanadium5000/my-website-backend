import { Elysia, t } from "elysia";
import { connectToDatabase } from "../db/connect";
import { auth } from "../auth";
import { ObjectId } from "mongodb";
import {
  FlashcardDeck,
  ContentElement,
  TextContent,
  MediaContent,
  Flashcard,
} from "../db/models";

const { flashcardsCollection } = await connectToDatabase();

// Schemas for OpenAPI
const ContentElementSchema = t.Union([
  t.Object({
    text: t.String(),
    type: t.Literal("text"),
  }),
  t.Object({
    mediaUrl: t.String(),
    type: t.Literal("media"),
  }),
]);

const FlashcardSchema = t.Object({
  word: t.Array(ContentElementSchema),
  definition: t.Array(ContentElementSchema),
});

const FlashcardDeckSchema = t.Object({
  _id: t.Optional(t.String()),
  userId: t.String(),
  title: t.String(),
  lastModified: t.String(),
  publishedTimestamp: t.String(),
  description: t.String(),
  thumbnail: t.String(),
  cards: t.Array(FlashcardSchema),
  createdAt: t.Date(),
});

const CreateFlashcardDeckSchema = t.Object({
  title: t.String({
    minLength: 1,
    maxLength: 100,
    description: "Title of the flashcard deck",
  }),
  description: t.String({
    maxLength: 500,
    description: "Description of the flashcard deck",
  }),
  thumbnail: t.String({
    description: "URL to thumbnail image",
  }),
  cards: t.Array(FlashcardSchema, {
    maxItems: 1000, // Reasonable limit for 95% of users
    description: "Array of flashcards, max 1000 cards",
  }),
});

const UpdateFlashcardDeckSchema = t.Object({
  title: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 100,
    })
  ),
  description: t.Optional(
    t.String({
      maxLength: 500,
    })
  ),
  thumbnail: t.Optional(t.String()),
  cards: t.Optional(
    t.Array(FlashcardSchema, {
      maxItems: 1000,
    })
  ),
});

export const quizspireRoutes = new Elysia({ prefix: "/quizspire" })
  .derive(async ({ request: { headers } }) => {
    const session = await auth.api.getSession({ headers }).catch(() => null);
    return { currentUser: session?.user };
  })
  .onError(({ error: err, set }) => {
    if (err instanceof Error) {
      if (err.message === "Unauthorized") {
        set.status = 401;
        return { message: "Unauthorized" };
      }
      if (err.message === "Deck not found") {
        set.status = 404;
        return { message: "Deck not found" };
      }
      if (err.message === "Forbidden: Access denied") {
        set.status = 403;
        return { message: "Forbidden: Access denied" };
      }
      if (err.message === "Invalid deck ID format") {
        set.status = 400;
        return { message: "Invalid deck ID format" };
      }
      if (err.message === "Deck size limit exceeded") {
        set.status = 400;
        return { message: "Deck size limit exceeded (max 1000 cards)" };
      }
      console.error("Unhandled error:", err.message);
    }
    set.status = 500;
    return { message: "Internal server error" };
  })
  // GET /quizspire/decks - List user's flashcard decks
  .get(
    "/decks",
    async ({ currentUser, query }) => {
      if (!currentUser) {
        throw new Error("Unauthorized");
      }

      const limit = Math.min(parseInt(query.limit || "50"), 100);
      const skip = parseInt(query.skip || "0");

      const decks = await flashcardsCollection
        .find({ userId: currentUser.id })
        .sort({ lastModified: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      return decks.map((deck) => ({
        ...deck,
        _id: deck._id.toString(),
      }));
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        skip: t.Optional(t.String()),
      }),
      response: t.Array(FlashcardDeckSchema),
      detail: {
        summary: "Get user's flashcard decks",
        tags: ["quizspire"],
        security: [{ session: [] }],
      },
    }
  )
  // POST /quizspire/decks - Create a new flashcard deck
  .post(
    "/decks",
    async ({ body, currentUser }) => {
      if (!currentUser) {
        throw new Error("Unauthorized");
      }

      if (body.cards.length > 1000) {
        throw new Error("Deck size limit exceeded");
      }

      const now = new Date().toISOString();
      const deck: FlashcardDeck = {
        userId: currentUser.id,
        title: body.title,
        lastModified: now,
        publishedTimestamp: now,
        description: body.description,
        thumbnail: body.thumbnail,
        cards: body.cards,
        createdAt: new Date(),
      };

      const { insertedId } = await flashcardsCollection.insertOne(deck);

      return {
        ...deck,
        _id: insertedId.toString(),
      };
    },
    {
      body: CreateFlashcardDeckSchema,
      response: FlashcardDeckSchema,
      detail: {
        summary: "Create a new flashcard deck",
        tags: ["quizspire"],
        security: [{ session: [] }],
      },
    }
  )
  // GET /quizspire/decks/:id - Get a specific deck
  .get(
    "/decks/:id",
    async ({ params: { id }, currentUser }) => {
      if (!currentUser) {
        throw new Error("Unauthorized");
      }

      let parsedId: ObjectId;
      try {
        parsedId = new ObjectId(id);
      } catch (error) {
        throw new Error("Invalid deck ID format");
      }

      const deck = await flashcardsCollection.findOne({
        _id: parsedId,
        userId: currentUser.id,
      });

      if (!deck) {
        throw new Error("Deck not found");
      }

      return {
        ...deck,
        _id: deck._id.toString(),
      };
    },
    {
      params: t.Object({
        id: t.String({
          description: "Deck ID (ObjectId string)",
        }),
      }),
      response: FlashcardDeckSchema,
      detail: {
        summary: "Get a specific flashcard deck",
        tags: ["quizspire"],
        security: [{ session: [] }],
      },
    }
  )
  // PUT /quizspire/decks/:id - Update a deck
  .put(
    "/decks/:id",
    async ({ params: { id }, body, currentUser }) => {
      if (!currentUser) {
        throw new Error("Unauthorized");
      }

      let parsedId: ObjectId;
      try {
        parsedId = new ObjectId(id);
      } catch (error) {
        throw new Error("Invalid deck ID format");
      }

      const existingDeck = await flashcardsCollection.findOne({
        _id: parsedId,
        userId: currentUser.id,
      });

      if (!existingDeck) {
        throw new Error("Deck not found");
      }

      const cards = body.cards !== undefined ? body.cards : existingDeck.cards;
      if (cards.length > 1000) {
        throw new Error("Deck size limit exceeded");
      }

      const updateData: Partial<FlashcardDeck> = {
        lastModified: new Date().toISOString(),
      };

      if (body.title !== undefined) updateData.title = body.title;
      if (body.description !== undefined)
        updateData.description = body.description;
      if (body.thumbnail !== undefined) updateData.thumbnail = body.thumbnail;
      if (body.cards !== undefined) updateData.cards = body.cards;

      await flashcardsCollection.updateOne(
        { _id: parsedId },
        { $set: updateData }
      );

      const updatedDeck = await flashcardsCollection.findOne({ _id: parsedId });
      if (!updatedDeck) {
        throw new Error("Deck not found");
      }

      return {
        ...updatedDeck,
        _id: updatedDeck._id.toString(),
      };
    },
    {
      params: t.Object({
        id: t.String({
          description: "Deck ID (ObjectId string)",
        }),
      }),
      body: UpdateFlashcardDeckSchema,
      response: FlashcardDeckSchema,
      detail: {
        summary: "Update a flashcard deck",
        tags: ["quizspire"],
        security: [{ session: [] }],
      },
    }
  )
  // DELETE /quizspire/decks/:id - Delete a deck
  .delete(
    "/decks/:id",
    async ({ params: { id }, currentUser }) => {
      if (!currentUser) {
        throw new Error("Unauthorized");
      }

      let parsedId: ObjectId;
      try {
        parsedId = new ObjectId(id);
      } catch (error) {
        throw new Error("Invalid deck ID format");
      }

      const result = await flashcardsCollection.deleteOne({
        _id: parsedId,
        userId: currentUser.id,
      });

      if (result.deletedCount === 0) {
        throw new Error("Deck not found");
      }

      return { success: true };
    },
    {
      params: t.Object({
        id: t.String({
          description: "Deck ID (ObjectId string)",
        }),
      }),
      response: t.Object({
        success: t.Boolean(),
      }),
      detail: {
        summary: "Delete a flashcard deck",
        tags: ["quizspire"],
        security: [{ session: [] }],
      },
    }
  )
  .model({ FlashcardDeckSchema });
