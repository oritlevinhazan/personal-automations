import dotenv from "dotenv";
dotenv.config();

import { createEnrollmentJobs, envokeJobs } from "./lib/arbox.js";
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

const REGISTER_TIME = process.env.REGISTER_TIME || "16:00:10";
const RETRY_TIMES = ["16:02:00", "16:05:00"];
const PREPARE_SECONDS = 300;
const SKIP_WAIT = process.env.SKIP_WAIT === "true";
const DRY_RUN = process.env.DRY_RUN === "true";

if (!SKIP_WAIT) {
    const ms = getMillisUntil(REGISTER_TIME) - PREPARE_SECONDS * 1000;
    if (ms > 0) {
        console.log(`Waiting ${Math.round(ms / 1000)} seconds to prepare jobs...`);
        await wait(ms);
    }
}

console.log("Preparing jobs...");
let result = await createEnrollmentJobs();

if (!SKIP_WAIT) {
    const msToRegister = getMillisUntil(REGISTER_TIME);
    if (msToRegister > 60 * 1000) {
        console.log(`Waiting ${Math.round(msToRegister / 1000)} seconds to enroll...`);
        await wait(msToRegister);
    }
}

console.log("Enrolling...");
await envokeJobs(DRY_RUN);

// Retry days where schedule wasn't published yet, or classes weren't found (may appear shortly after 16:00)
let daysToRetry = [...new Set([...result.notPublished, ...result.notFound])];

for (let i = 0; i < RETRY_TIMES.length; i++) {
    if (daysToRetry.length === 0) break;

    const retryTime = RETRY_TIMES[i];
    const nextRetryTime = RETRY_TIMES[i + 1];
    const dayNames = { 0: "ראשון", 2: "שלישי", 4: "חמישי" };
    const retryDayNames = daysToRetry.map(d => dayNames[d] || d).join(", ");

    const retryMsg = nextRetryTime
        ? `לא נמצאו שיעורים לימים: ${retryDayNames}\nמנסה שוב ב-${nextRetryTime.substring(0, 5)}...`
        : `לא נמצאו שיעורים לימים: ${retryDayNames}\nניסיון אחרון - אם לא יצליח, הירשמי ידנית!`;

    if (alertzyAccountKey) {
        await sendPushNotification(alertzyAccountKey, "⏳ מנסה שוב...", retryMsg);
    }

    if (!SKIP_WAIT) {
        const msToRetry = getMillisUntil(retryTime);
        if (msToRetry > 0) {
            console.log(`Waiting ${Math.round(msToRetry / 1000)} seconds to retry for days: ${retryDayNames}...`);
            await wait(msToRetry);
        }
    }

    console.log(`Retrying for days: ${retryDayNames}...`);
    result = await createEnrollmentJobs(daysToRetry);
    daysToRetry = [...new Set([...result.notPublished, ...result.notFound])];
    await envokeJobs(DRY_RUN);
}

if (result.missingDays.length > 0) {
    const dayNames = { 0: "ראשון", 2: "שלישי", 4: "חמישי" };
    const notPublishedNames = result.notPublished.map(d => dayNames[d] || d).join(", ");
    const fullNames = result.full.map(d => dayNames[d] || d).join(", ");
    const notFoundNames = result.notFound.map(d => dayNames[d] || d).join(", ");
    const lines = [];
    if (notPublishedNames) lines.push(`לוח זמנים עדיין לא פורסם: ${notPublishedNames}`);
    if (fullNames) lines.push(`השיעורים מלאים: ${fullNames}`);
    if (notFoundNames) lines.push(`שיעורים לא נמצאו: ${notFoundNames}`);
    if (alertzyAccountKey) {
        await sendPushNotification(alertzyAccountKey, "❌ הרישום נכשל", lines.join("\n") + "\nהירשמי ידנית!");
    }
}

console.log("Done!");
process.exit(0);
