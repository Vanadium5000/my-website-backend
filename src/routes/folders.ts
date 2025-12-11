import { Elysia, t } from "elysia";
import { auth } from "../auth";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const checkFolderAccess = (currentUser: any, folderName: string): boolean => {
  if (!currentUser) return false;
  if (currentUser.role?.includes("admin")) return true;
  const allowedFolders = currentUser.allowedFolders || [];
  return allowedFolders.includes(folderName);
};

const getFolderPath = (folderName: string): string => {
  return resolve("src/folders", folderName);
};

export const foldersRoutes = new Elysia({ prefix: "/folders" })
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
      if (err.message === "Forbidden") {
        set.status = 403;
        return { message: "Forbidden" };
      }
      if (err.message === "Folder not found") {
        set.status = 404;
        return { message: "Folder not found" };
      }
      if (err.message === "File not found") {
        set.status = 404;
        return { message: "File not found" };
      }
    }
    set.status = 500;
    return { message: "Internal server error" };
  })
  .get(
    "/:folderName",
    async ({ params: { folderName }, currentUser }) => {
      if (!checkFolderAccess(currentUser, folderName)) {
        throw new Error("Forbidden");
      }

      const folderPath = getFolderPath(folderName);
      try {
        const files = readdirSync(folderPath);
        const fileDetails = files.map((file) => {
          const filePath = join(folderPath, file);
          const stats = statSync(filePath);
          return {
            name: file,
            size: stats.size,
            isDirectory: stats.isDirectory(),
            modified: stats.mtime.toISOString(),
          };
        });
        return { files: fileDetails };
      } catch (error) {
        throw new Error("Folder not found");
      }
    },
    {
      params: t.Object({
        folderName: t.String({
          description: "Name of the folder to list",
        }),
      }),
      response: t.Object({
        files: t.Array(
          t.Object({
            name: t.String(),
            size: t.Number(),
            isDirectory: t.Boolean(),
            modified: t.String(),
          })
        ),
      }),
      detail: {
        summary: "List files in a protected folder",
        tags: ["folders"],
        security: [{ session: [] }],
      },
    }
  )
  .get(
    "/:folderName/*",
    async ({ params: { folderName, "*": path }, currentUser, set }) => {
      if (!checkFolderAccess(currentUser, folderName)) {
        throw new Error("Forbidden");
      }

      const folderPath = getFolderPath(folderName);
      const filePath = join(folderPath, path);

      // Prevent directory traversal
      const resolvedPath = resolve(filePath);
      if (!resolvedPath.startsWith(folderPath)) {
        throw new Error("Forbidden");
      }

      try {
        const file = Bun.file(resolvedPath);
        if (!(await file.exists())) {
          throw new Error("File not found");
        }
        return file;
      } catch (error) {
        throw new Error("File not found");
      }
    },
    {
      params: t.Object({
        folderName: t.String({
          description: "Name of the folder",
        }),
        "*": t.String({
          description: "Path to the file within the folder",
        }),
      }),
      detail: {
        summary: "Serve a file from a protected folder",
        tags: ["folders"],
        security: [{ session: [] }],
      },
    }
  );
