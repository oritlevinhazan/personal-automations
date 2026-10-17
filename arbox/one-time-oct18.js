import dotenv from "dotenv";
dotenv.config();

import fetch from "node-fetch";
import { sendPushNotification } from "../shared/push-notification.js";

const EMAIL = process.env.ARBOX_USER_EMAIL;
const PASSWORD = process.env.ARBOX_USER_PASSWORD;
const ALERTZY_KEY = process.env.ALERTZY_ACCOUNT_KEY;
const DRY_RUN = process.env.DRY_RUN === "true";
const SLOT = process.env.SLOT || "0900"; // "0900", "1000", "1100"
const MEMBERSHIP_ID = 13327706;
const LOCATION_ID = 21697;
const BASE_URL = "https://apiappv2.arboxapp.com/api/v2";

const TIME_MAP = { "0900": "09:00", "1000": "10:00", "1100": "11:00" };
const targetTime = TIME_MAP[SLOT];
if (!targetTime) {
    console.error(`Unknown SLOT: ${SLOT}. Use 0900, 1000, or 1100.`);
    process.exit(1);
}

const login = async () => {
    const res = await fetch(`${BASE_URL}/user/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (res.status !== 200) throw new Error(`Login failed: HTTP ${res.status}`);
    const data = await res.json();
    return { token: data.data.token, refreshToken: data.data.refreshToken };
};

const getSchedule = async (date, token, refreshToken) => {
    const res = await fetch(`${BASE_URL}/schedule/betweenDates`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            accesstoken: token,
            refreshtoken: refreshToken,
        },
        body: JSON.stringify({
            from: `${date}T00:00:00.000Z`,
            locations_box_id: LOCATION_ID,
            to: `${date}T00:00:00.000Z`,
        }),
    });
    if (res.status !== 200) throw new Error(`Schedule fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    return data.data || [];
};

const findClass = (schedule, time) =>
    schedule.find(
        (cls) =>
            cls.time === time &&
            (cls.box_categories?.name?.toLowerCase().includes("strength") ||
                cls.box_categories?.name?.toLowerCase().includes("power"))
    ) || null;

const isEnrolled = (cls) =>
    cls?.schedule_user?.some((u) => u.membership_user_fk === MEMBERSHIP_ID);

const enroll = async (cls, token, refreshToken) => {
    if (DRY_RUN) {
        console.log(`[DRY RUN] Would enroll in: ${cls.box_categories.name} at ${cls.time}`);
        return { ok: true };
    }
    const res = await fetch(`${BASE_URL}/scheduleUser/insert`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            accesstoken: token,
            refreshtoken: refreshToken,
        },
        body: JSON.stringify({ extras: null, membership_user_id: MEMBERSHIP_ID, schedule_id: cls.id }),
    });
    const data = await res.json();
    return { ok: res.status === 200, data };
};

const tryEnroll = async (cls, time, date, token, refreshToken) => {
    if (!cls) {
        console.log(`No strength/power class found at ${time}`);
        if (!DRY_RUN && ALERTZY_KEY) {
            await sendPushNotification(ALERTZY_KEY, "⚠️ שיעור לא נמצא", `לא נמצא שיעור בשעה ${time} ב-${date}`);
        }
        return false;
    }
    const label = `${cls.box_categories.name} ${time} (${date})`;
    if (cls.free <= 0) {
        console.log(`Class full: ${label}`);
        if (!DRY_RUN && ALERTZY_KEY) {
            await sendPushNotification(ALERTZY_KEY, "⏳ שיעור מלא", `⏳ ${label} מלא`);
        }
        return false;
    }
    const result = await enroll(cls, token, refreshToken);
    if (result.ok) {
        console.log(`Enrolled! ${label}`);
        if (!DRY_RUN && ALERTZY_KEY) {
            await sendPushNotification(ALERTZY_KEY, "✅ נרשמת!", `✅ ${label}`);
        }
        return true;
    }
    const rawReason = result.data?.error?.messageToUser || result.data?.message;
    const reason = Array.isArray(rawReason)
        ? rawReason[0]?.message || JSON.stringify(rawReason[0])
        : typeof rawReason === "string" ? rawReason : JSON.stringify(rawReason);
    console.log(`Enrollment failed: ${reason}`);
    if (!DRY_RUN && ALERTZY_KEY) {
        await sendPushNotification(ALERTZY_KEY, "❌ הרישום נכשל", `❌ ${label}\n${reason}`);
    }
    return false;
};

console.log(`One-time Oct 18 enrollment — slot: ${targetTime}`);
const { token, refreshToken } = await login();
const date = "2026-10-18";
console.log(`Target date: ${date}`);

const schedule = await getSchedule(date, token, refreshToken);

const cls0900 = findClass(schedule, "09:00");
const cls1000 = findClass(schedule, "10:00");
const cls1100 = findClass(schedule, "11:00");

if (SLOT === "1000" || SLOT === "1100") {
    // Check if already enrolled in 09:00
    if (isEnrolled(cls0900)) {
        console.log("Already enrolled in 09:00 — skipping.");
        process.exit(0);
    }
    // Spot freed up in 09:00?
    if (cls0900 && cls0900.free > 0) {
        console.log("Spot opened in 09:00 — grabbing it.");
        await tryEnroll(cls0900, "09:00", date, token, refreshToken);
        process.exit(0);
    }
}

if (SLOT === "1100") {
    // Check if already enrolled in 10:00
    if (isEnrolled(cls1000)) {
        console.log("Already enrolled in 10:00 — skipping.");
        process.exit(0);
    }
    // Spot freed up in 10:00?
    if (cls1000 && cls1000.free > 0) {
        console.log("Spot opened in 10:00 — grabbing it.");
        await tryEnroll(cls1000, "10:00", date, token, refreshToken);
        process.exit(0);
    }
}

// Try the target slot
const clsTarget = SLOT === "0900" ? cls0900 : SLOT === "1000" ? cls1000 : cls1100;
await tryEnroll(clsTarget, targetTime, date, token, refreshToken);

console.log("Done!");
process.exit(0);
