import { Elysia, t } from "elysia";
import { getLeaderboards } from "../utils/profile";
import { PublicUserSchema } from "./profile";

export const leaderboardsRoutes = new Elysia({ prefix: "/leaderboards" })
  .onError(({ error: err, set }) => {
    if (err instanceof Error) {
      if (err.message === "Attribute parameter is required") {
        set.status = 400;
        return { message: "Attribute parameter is required" };
      }
      if (err.message === "Invalid attribute name for leaderboard") {
        set.status = 400;
        return { message: "Invalid attribute name" };
      }
      if (err.message === "No profiles found with the specified attribute") {
        set.status = 404;
        return { message: "No profiles found with the specified attribute" };
      }
      console.error("Unhandled error:", err.message);
    }
    set.status = 500;
    return { message: "Internal server error" };
  })
  .get(
    "/",
    async ({ query: { attribute } }) => {
      if (!attribute) {
        throw new Error("Attribute parameter is required");
      }

      return await getLeaderboards(attribute);
    },
    {
      query: t.Object({
        attribute: t.String({
          description: `The attribute name to rank users by (e.g., chessWins). Allowed attributes: age, chessWins, chessLosses, draughtsWins, draughtsLosses, name.`,
        }),
      }),
      response: t.Array(PublicUserSchema),
      detail: {
        summary: "Get leaderboard of users ranked by a specific attribute",
        tags: ["leaderboards"],
        description: `Retrieves a list of public user profiles ranked by the specified attribute value in descending order. Allowed attributes: age, chessWins, chessLosses, draughtsWins, draughtsLosses, name.`,
      },
    }
  );
