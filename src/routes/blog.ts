import { Elysia, t } from "elysia";
import { connectToDatabase } from "../db/connect";
import { auth } from "../auth";
import { marked } from "marked";
import { markedHighlight } from "marked-highlight";
import Prism from "prismjs";
import { readdirSync, existsSync } from "node:fs";
import matter from "gray-matter";
import DOMPurify from "isomorphic-dompurify";
import { rateLimit } from "elysia-rate-limit";
import { Collection, ObjectId } from "mongodb";
import { Reaction, Comment } from "../db/models";
import { Window } from "happy-dom";

// Use an async IIFE to handle getting the user collection
let commentsCollection: Collection<Comment>;
let reactionsCollection: Collection<Reaction>;
(async () => {
  const connection = await connectToDatabase();
  commentsCollection = connection.commentsCollection;
  reactionsCollection = connection.reactionsCollection;
})();

marked.use(
  markedHighlight({
    highlight: (code, lang) => {
      const language = Prism.languages[lang] ? lang : "plaintext";
      return Prism.highlight(code, Prism.languages[language], language);
    },
  })
);

const getBlogsFromFiles = async () => {
  const files = readdirSync("src/blogs").filter((f) => f.endsWith(".md"));
  const blogs = [];
  for (const name of files) {
    const id = name.slice(0, -3);
    const filePath = `src/blogs/${name}`;
    try {
      const file = Bun.file(filePath);
      const markdown = await file.text();
      const { data, content } = matter(markdown);
      if (!data.title || !data.snippet || !data.createdAt || !data.updatedAt) {
        console.warn(`Invalid frontmatter in ${filePath}`);
        continue;
      }
      blogs.push({
        id,
        title: data.title,
        snippet: data.snippet,
        createdAt: new Date(data.createdAt),
        updatedAt: new Date(data.updatedAt),
        markdownContent: content,
      });
    } catch (error) {
      console.error(`Error reading ${filePath}:`, error);
      continue;
    }
  }
  return blogs;
};

const getBlogsWithCounts = async () => {
  const blogs = await getBlogsFromFiles();
  const blogIds = blogs.map((b) => b.id);
  const reactions = await reactionsCollection
    .find({ blogId: { $in: blogIds } })
    .toArray();
  const comments = await commentsCollection
    .find({ blogId: { $in: blogIds } })
    .toArray();
  const reactionMap = new Map<string, number>();
  reactions.forEach((r) => {
    const key = `${r.blogId}-${r.type}`;
    reactionMap.set(key, (reactionMap.get(key) || 0) + 1);
  });
  const commentMap = new Map<string, number>();
  comments.forEach((c) => {
    commentMap.set(c.blogId, (commentMap.get(c.blogId) || 0) + 1);
  });
  return blogs.map((b) => ({
    ...b,
    likes: reactionMap.get(`${b.id}-like`) || 0,
    dislikes: reactionMap.get(`${b.id}-dislike`) || 0,
    commentCount: commentMap.get(b.id) || 0,
  }));
};

const BlogIndexSchema = t.Object({
  id: t.String(),
  title: t.String(),
  snippet: t.String(),
  likes: t.Number(),
  dislikes: t.Number(),
  commentCount: t.Number(),
  createdAt: t.Date(),
  updatedAt: t.Date(),
  markdownContent: t.String(),
});

const BlogDetailSchema = t.Object({
  id: t.String(),
  title: t.String(),
  snippet: t.String(),
  content: t.String(),
  likes: t.Number(),
  dislikes: t.Number(),
  commentCount: t.Number(),
  createdAt: t.Date(),
  updatedAt: t.Date(),
});

const CommentSchema = t.Object({
  _id: t.Optional(t.String()),
  blogId: t.String(),
  authorId: t.String(),
  content: t.String(),
  accepted: t.Boolean(),
  createdAt: t.Date(),
});

export const blogRoutes = new Elysia({ prefix: "/blog" })
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
      if (err.message === "Blog post not found") {
        set.status = 404;
        return { message: "Blog post not found" };
      }
      if (err.message === "Comment content is required") {
        set.status = 400;
        return { message: "Comment content is required" };
      }
      if (err.message === "Forbidden: Admin access required") {
        set.status = 403;
        return { message: "Forbidden: Admin access required" };
      }
      if (err.message === "Comment ID is required") {
        set.status = 400;
        return { message: "Comment ID is required" };
      }
      if (err.message === "Invalid comment ID format") {
        set.status = 400;
        return { message: "Invalid comment ID format" };
      }
      if (err.message === "Comment not found") {
        set.status = 404;
        return { message: "Comment not found" };
      }
      if (err.message === "Comment is already accepted") {
        set.status = 400;
        return { message: "Comment is already accepted" };
      }
      if (err.message === "Comment is already denied") {
        set.status = 400;
        return { message: "Comment is already denied" };
      }
      if (err.message === "Action must be 'accept', 'deny', or 'delete'") {
        set.status = 400;
        return { message: "Action must be 'accept', 'deny', or 'delete'" };
      }
      console.error("Unhandled error:", err.message);
    }
    set.status = 500;
    return { message: "Internal server error" };
  })
  .get(
    "/",
    async () => {
      return await getBlogsWithCounts();
    },
    {
      response: t.Array(BlogIndexSchema),
      detail: {
        summary: "Get all blog posts with comment counts",
        tags: ["blogs"],
      },
    }
  )
  .model({ BlogIndexSchema: BlogIndexSchema })
  .get(
    "/:id",
    async ({ params: { id } }) => {
      const blogs = await getBlogsFromFiles();
      const blog = blogs.find((b) => b.id === id);
      if (!blog) {
        throw new Error("Blog post not found");
      }

      const content = await marked(blog.markdownContent);

      const reactions = await reactionsCollection
        .find({ blogId: id })
        .toArray();
      const likes = reactions.filter((r) => r.type === "like").length;
      const dislikes = reactions.filter((r) => r.type === "dislike").length;

      const comments = (
        await commentsCollection.find({ blogId: id }).toArray()
      ).map((c) => ({
        ...c,
        _id: c._id.toString(),
      }));
      const commentCount = comments.length;

      const blogWithCounts = {
        ...blog,
        content,
        likes,
        dislikes,
        commentCount,
      };

      return { blog: blogWithCounts, comments };
    },
    {
      params: t.Object({
        id: t.String({
          description: "Blog post ID (filename without .md)",
        }),
      }),
      response: t.Object({
        blog: BlogDetailSchema,
        comments: t.Array(CommentSchema),
      }),

      detail: {
        summary: "Get blog post by ID with its comments",
        tags: ["blogs"],
      },
    }
  )
  .model({ BlogDetailSchema: BlogDetailSchema })
  .use(
    rateLimit({
      duration: 120_000, // 2 minutes (in ms) - adjust as needed
      max: 2, // Max requests per duration - adjust as needed
      skip: (request) => {
        const pathname = new URL(request.url).pathname;

        // Only apply to paths matching /*/comment (where * is anything)
        return !pathname.match(/^\/.+\/comment$/);
      },
      // Optional: Customize response when limit is hit
      errorResponse: "Rate limit exceeded. Try again later.",
      generator: (req, server, { ip }) => ip, // Custom generator as getting IP on BunJS is different
    })
  )
  .post(
    "/:id/comment",
    async ({ params: { id }, body: { content }, currentUser }) => {
      if (!currentUser) {
        throw new Error("Unauthorized");
      }
      if (
        !content ||
        typeof content !== "string" ||
        content.trim().length === 0
      ) {
        throw new Error("Comment content is required");
      }

      if (!existsSync(`src/blogs/${id}.md`)) {
        throw new Error("Blog post not found");
      }

      const renderedContent = await marked(content.trim());
      const sanitizedContent = DOMPurify.sanitize(renderedContent);

      const { insertedId } = await commentsCollection.insertOne({
        blogId: id,
        authorId: currentUser.id,
        content: sanitizedContent,
        accepted: false,
        createdAt: new Date(),
      });

      return { success: true, commentId: insertedId.toString() };
    },
    {
      params: t.Object({
        id: t.String({
          description: "Blog post ID (filename without .md)",
        }),
      }),
      body: t.Object({
        content: t.String({
          description: "Comment content",
        }),
      }),
      response: t.Object({
        success: t.Boolean(),
        commentId: t.String(),
      }),
      detail: {
        summary: "Add a comment to a blog post (unpublished by default)",
        tags: ["blogs", "comments"],
        security: [{ session: [] }],
      },
    }
  )
  .get(
    "/:id/reaction",
    async ({ params: { id }, currentUser }) => {
      if (!currentUser) {
        throw new Error("Unauthorized");
      }

      const reaction = await reactionsCollection.findOne({
        blogId: id,
        userId: currentUser.id,
      });

      const hasLiked = reaction?.type === "like";
      const hasDisliked = reaction?.type === "dislike";

      return [hasLiked, hasDisliked];
    },
    {
      params: t.Object({
        id: t.String({
          description: "Blog post ID (filename without .md)",
        }),
      }),
      response: t.Array(t.Boolean(), {
        minItems: 2,
        maxItems: 2,
        description: "[hasLiked, hasDisliked]",
      }),
      detail: {
        summary: "Get current user's reaction on a blog post",
        tags: ["blogs", "reactions"],
        security: [{ session: [] }],
      },
    }
  )
  .patch(
    "/:id/reaction",
    async ({ params: { id }, body: { type }, currentUser }) => {
      if (!currentUser) {
        throw new Error("Unauthorized");
      }

      const filePath = `src/blogs/${id}.md`;
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        throw new Error("Blog post not found");
      }

      const existingReaction = await reactionsCollection.findOne({
        blogId: id,
        userId: currentUser.id,
      });

      let operation: any;

      if (!existingReaction) {
        // Insert new reaction
        operation = {
          insertOne: {
            document: {
              blogId: id,
              userId: currentUser.id,
              type,
              createdAt: new Date(),
            },
          },
        };
      } else if (existingReaction.type === type) {
        // Toggle off
        operation = { deleteOne: { filter: { _id: existingReaction._id } } };
      } else {
        // Switch type
        operation = {
          updateOne: {
            filter: { _id: existingReaction._id },
            update: { $set: { type } },
          },
        };
      }

      await reactionsCollection.bulkWrite([operation]);

      return { success: true };
    },
    {
      params: t.Object({
        id: t.String({
          description: "Blog post ID (filename without .md)",
        }),
      }),
      body: t.Object({
        type: t.Union([t.Literal("like"), t.Literal("dislike")]),
      }),
      response: t.Object({
        success: t.Boolean(),
      }),
      detail: {
        summary: "Set or toggle user's reaction on a blog post",
        tags: ["blogs", "reactions"],
        security: [{ session: [] }],
      },
    }
  )
  .get(
    "/admin/comments/pending",
    async ({ currentUser, set }) => {
      // Check if user is admin
      if (!currentUser?.role?.includes("admin")) {
        set.status = 403;
        throw new Error("Forbidden: Admin access required");
      }

      const pendingComments = await commentsCollection
        .find({ accepted: false })
        .toArray();

      return pendingComments.map((comment) => ({
        ...comment,
        _id: comment._id.toString(),
      }));
    },
    {
      response: t.Array(CommentSchema),
      detail: {
        summary: "Get all pending (unaccepted) comments - Admin only",
        tags: ["admin", "comments"],
        security: [{ session: [] }],
      },
    }
  )
  .model({ Comment: CommentSchema })
  .patch(
    "/admin/comments/:commentId/moderate",
    async ({ params: { commentId }, body: { action }, currentUser, set }) => {
      // Check if user is admin
      if (!currentUser?.role?.includes("admin")) {
        set.status = 403;
        throw new Error("Forbidden: Admin access required");
      }

      if (!commentId) {
        set.status = 400;
        throw new Error("Comment ID is required");
      }

      if (!action || !["accept", "deny", "delete"].includes(action)) {
        set.status = 400;
        throw new Error("Action must be 'accept', 'deny', or 'delete'");
      }

      let parsedCommentId: ObjectId;
      try {
        parsedCommentId = new ObjectId(commentId);
      } catch (error) {
        set.status = 400;
        throw new Error("Invalid comment ID format");
      }

      const comment = await commentsCollection.findOne({
        _id: parsedCommentId,
      });

      if (!comment) {
        set.status = 404;
        throw new Error("Comment not found");
      }

      let updateOperation: any;
      let success = false;

      switch (action) {
        case "accept":
          if (comment.accepted) {
            set.status = 400;
            throw new Error("Comment is already accepted");
          }
          updateOperation = { $set: { accepted: true } };
          success = true;
          break;

        case "deny":
          if (!comment.accepted) {
            set.status = 400;
            throw new Error("Comment is already denied");
          }
          updateOperation = { $set: { accepted: false } };
          success = true;
          break;

        case "delete":
          const deleteResult = await commentsCollection.deleteOne({
            _id: parsedCommentId,
          });
          return { success: deleteResult.deletedCount === 1 };

        default:
          set.status = 400;
          throw new Error("Invalid action");
      }

      if (updateOperation) {
        const result = await commentsCollection.updateOne(
          { _id: parsedCommentId },
          updateOperation
        );

        if (result.matchedCount === 0) {
          set.status = 404;
          throw new Error("Comment not found");
        }

        return { success };
      }

      return { success: false };
    },
    {
      params: t.Object({
        commentId: t.String({
          description: "Comment ID (ObjectId string)",
        }),
      }),
      body: t.Object({
        action: t.Union([
          t.Literal("accept", {
            description: "Approve and publish the comment",
          }),
          t.Literal("deny", { description: "Deny and hide the comment" }),
          t.Literal("delete", {
            description: "Permanently delete the comment",
          }),
        ]),
      }),
      response: t.Object({
        success: t.Boolean(),
      }),
      detail: {
        summary: "Moderate a comment (accept, deny, or delete) - Admin only",
        tags: ["admin", "comments"],
        security: [{ session: [] }],
        description: `
Admin moderation actions for comments:
- **accept**: Sets comment accepted=true, makes it visible to all users
- **deny**: Sets comment accepted=false, hides it from public view
- **delete**: Permanently removes the comment from database

Requires admin authentication. Only comments that need moderation will be visible to admins.
        `,
      },
    }
  );
