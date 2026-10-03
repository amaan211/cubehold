import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATA_DIR
      ? `file:${process.env.DATA_DIR}/cubehold.db`
      : "file:./data/cubehold.db",
  },
  strict: true,
  verbose: true,
});
