import { Elysia, t } from "elysia";

const colors: string[] = [
  "#007AFF", // Blue
  "#4CD964", // Green
  "#FFCC00", // Yellow
  "#FF9500", // Orange
  "#FF3B30", // Red
  "#AF52DE", // Purple
  "#FF2D55", // Pink
  "#5AC8FA", // Teal
  "#5856D6", // Indigo
  "#8E8E93", // Gray
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) % 2 ** 32;
  }
  return Math.abs(hash);
}

function getInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export const avatarRoutes = new Elysia({ prefix: "/avatar" }).get(
  "/",
  async ({ query: { name }, set }) => {
    if (!name) {
      set.status = 400;
      return "Missing name";
    }
    const initials = getInitials(name);
    if (!initials) {
      set.status = 400;
      return "Invalid name";
    }
    const hash = hashString(name.toLowerCase());
    const color = colors[hash % colors.length];
    const fontSize = initials.length === 1 ? 140 : 100;
    const svg = `
        <svg width="250" height="250" xmlns="http://www.w3.org/2000/svg">
          <circle cx="125" cy="125" r="125" fill="${color}" />
          <text x="125" y="125" font-size="${fontSize}" text-anchor="middle" dominant-baseline="central" fill="white" font-family="sans-serif">${initials}</text>
        </svg>
      `;
    const base64 = Buffer.from(svg).toString("base64");
    return `data:image/svg+xml;base64,${base64}`;
  },
  {
    query: t.Object({
      name: t.String({
        minLength: 1,
        description:
          'The full name to generate initials from (e.g., "John Smith")',
      }),
    }),
    response: t.String({
      description: "Base64 encoded SVG image data URL",
    }),
    detail: {
      summary: "Generate avatar image from name initials",
      tags: ["avatars"],
    },
  }
);
