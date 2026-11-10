// Live fix: enroll one weekday (0=Sun,2=Tue,4=Thu) right now using the normal priority list.
// Safe to re-run: skips days that already have a booking. Usage: node arbox/enroll-now.js 0
import dotenv from "dotenv";
dotenv.config();
import { loginArbox, enrollDay } from "./lib/arbox.js";

const day = Number(process.argv[2]);
if (![0, 2, 4].includes(day)) { console.error("day must be 0, 2 or 4"); process.exit(1); }
await loginArbox();
const r = await enrollDay(day, { dryRun: false, pollUntil: 0 });
console.log(JSON.stringify(r));
process.exit(0);
