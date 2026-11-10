import dotenv from "dotenv";
dotenv.config();

import { loginArbox, enrollDay } from "./lib/arbox.js";
import { sendPushNotification } from "../shared/push-notification.js";
import config from "./data/config.js";

const { alertzyAccountKey } = config;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getMillisUntil = (timeStr) => {
    const [hours, minutes, seconds] = timeStr.split(":").map(Number);
    const now = new Date();
    const israelTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
    const target = new Date(israelTime);
    target.setHours(hours, minutes, seconds, 0);
    // if the time has already passed today, schedule for tomorrow
    // unless we're less than 10 minutes late (e.g. workflow startup delay)
    if (target <= israelTime) {
        if (israelTime - target < 10 * 60 * 1000) {
            return 0;
        }
        target.setDate(target.getDate() + 1);
    }
    return target - israelTime;
};

// The schedule is published at 16:00 sharp. We log in beforehand, start polling a couple of seconds
// early, and enroll each day the moment its schedule appears (all days run in parallel).
const REGISTER_TIME = process.env.REGISTER_TIME || "16:00:00";
const EARLY_START_SECONDS = 2;
const POLL_SECONDS = 60;
const RETRY_TIMES = ["16:02:00", "16:05:00"];
const DAYS = [0, 2, 4];
const DAY_NAMES = { 0: "ראשון", 2: "שלישי", 4: "חמישי" };
const SKIP_WAIT = process.env.SKIP_WAIT === "true";
const DRY_RUN = process.env.DRY_RUN === "true";

console.log("Logging in...");
await loginArbox();

if (!SKIP_WAIT) {
    const ms = getMillisUntil(REGISTER_TIME) - EARLY_START_SECONDS * 1000;
    if (ms > 0) {
        console.log(`Waiting ${Math.round(ms / 1000)} seconds until registration opens...`);
        await wait(ms);
    }
}

console.log("Enrolling (all days in parallel)...");
const pollUntil = SKIP_WAIT ? 0 : Date.now() + POLL_SECONDS * 1000;
const outcomes = {};
const apply = (results) => results.forEach((r) => (outcomes[r.day] = r));
apply(await Promise.all(DAYS.map((d) => enrollDay(d, { dryRun: DRY_RUN, pollUntil }))));

// Retry only days whose schedule still wasn't published
for (const retryTime of RETRY_TIMES) {
    const pending = DAYS.filter((d) => outcomes[d].status === "notPublished");
    if (pending.length === 0) break;
    const names = pending.map((d) => DAY_NAMES[d]).join(", ");
    if (alertzyAccountKey && !DRY_RUN) {
        await sendPushNotification(alertzyAccountKey, "⏳ מנסה שוב...", `לוח זמנים טרם פורסם: ${names}\nמנסה שוב ב-${retryTime.substring(0, 5)}...`);
    }
    if (!SKIP_WAIT) {
        const ms = getMillisUntil(retryTime);
        if (ms > 0) {
            console.log(`Waiting ${Math.round(ms / 1000)} seconds to retry for days: ${names}...`);
            await wait(ms);
        }
    }
    console.log(`Retrying for days: ${names}...`);
    apply(await Promise.all(pending.map((d) => enrollDay(d, { dryRun: DRY_RUN, pollUntil: 0 }))));
}

// Build one consolidated message
const lines = [];
for (const d of DAYS) {
    const o = outcomes[d];
    const day = DAY_NAMES[d];
    for (const f of o.failures) lines.push(`❌ ${f}`);
    if (o.status === "enrolled") {
        lines.push(`✅ ${day}: ${o.label}`);
        if (o.full.length) lines.push(`⏳ ${day}: ${o.full.join(", ")} מלא — הירשמי ידנית לרשימת המתנה`);
    } else if (o.status === "full") {
        lines.push(`⏳ ${day}: הכל מלא (${o.full.join(", ")}) — הירשמי ידנית להמתנה`);
    } else if (o.status === "notFound") {
        lines.push(`⚠️ ${day}: שיעורים לא נמצאו`);
    } else {
        lines.push(`⚠️ ${day}: לוח לא פורסם`);
    }
}
console.log(lines.join("\n"));

if (!DRY_RUN && alertzyAccountKey) {
    const anyEnrolled = DAYS.some((d) => outcomes[d].status === "enrolled");
    await sendPushNotification(alertzyAccountKey, anyEnrolled ? "✅ הרישום הסתיים" : "❌ הרישום הסתיים", lines.join("\n"));
}

console.log("Done!");
process.exit(0);
