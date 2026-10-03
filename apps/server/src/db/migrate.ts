import { createDb, initDb } from "./index.js";

const db = createDb();
await initDb(db);
console.log("Migrations applied.");
