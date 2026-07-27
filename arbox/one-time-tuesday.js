import dotenv from "dotenv";
dotenv.config();

import fetch from "node-fetch";
import { sendPushNotification } from "../shared/push-notification.js";

const EMAIL = process.env.ARBOX_USER_EMAIL;
const PASSWORD = process.env.ARBOX_USER_PASSWORD;
const ALERTZY_KEY = process.env.ALERTZY_ACCOUNT_KEY;
const DRY_RUN = process.env.DRY_RUN === "true";
const SLOT = process.env.SLOT || "0830"; // "0830" or "0930"
const MEMBERSHIP_ID = 13327706;
const LOCATION_ID = 21697;
const BASE_URL = "https://apiappv2.arboxapp.com/api/v2";

const TIME_MAP = { "0830": "08:30", "0930": "09:30" };
const targetTime = TIME_MAP[SLOT];
if (!targetTime) {
    console.error(`Unknown SLOT: ${SLOT}. Use 0830 or 0930.`);
    process.exit(1);
}

const getNextTuesdayDate = () => {
    const now = new Date();
    const israelTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
    const dayOfWeek = israelTime.getDay();
    const daysUntil = (2 - dayOfWeek + 7) % 7 || 7;
    israelTime.setDate(israelTime.getDate() + daysUntil);
    const y = israelTime.getFullYear();
    const m = String(israelTime.getMonth() + 1).padStart(2, "0");
    const d = String(israelTime.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
};

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

console.log(`One-time Tuesday enrollment — slot: ${targetTime}`);
const { token, refreshToken } = await login();
const date = getNextTuesdayDate();
console.log(`Target date: ${date}`);

const schedule = await getSchedule(date, token, refreshToken);

const isEnrolled = (cls) => cls?.schedule_user?.some(u => u.membership_user_fk === MEMBERSHIP_ID);

// For the 09:30 slot: skip if already enrolled in 08:30, otherwise try 08:30 first
if (SLOT === "0930") {
    const cls0830 = findClass(schedule, "08:30");
    if (isEnrolled(cls0830)) {
        console.log("Already enrolled in 08:30 — skipping 09:30 attempt.");
        process.exit(0);
    }
    if (cls0830 && cls0830.free > 0) {
        console.log("Spot opened in 08:30 — trying that first.");
        const label0830 = `${cls0830.box_categories.name} 08:30 (${date})`;
        const result0830 = await enroll(cls0830, token, refreshToken);
        if (result0830.ok) {
            console.log(`Enrolled in 08:30! ${label0830}`);
            if (!DRY_RUN && ALERTZY_KEY) {
                await sendPushNotification(ALERTZY_KEY, "✅ נרשמת!", `✅ ${label0830}`);
            }
            process.exit(0);
        }
        console.log("08:30 enrollment failed, falling through to 09:30...");
    }
}

const cls = findClass(schedule, targetTime);

if (!cls) {
    console.log(`No strength/power class found at ${targetTime}`);
    if (!DRY_RUN && ALERTZY_KEY) {
        await sendPushNotification(ALERTZY_KEY, "⚠️ שיעור לא נמצא", `לא נמצא שיעור בשעה ${targetTime} ביום שלישי ${date}`);
    }
    process.exit(0);
}

const label = `${cls.box_categories.name} ${targetTime} (${date})`;

if (cls.free <= 0) {
    console.log(`Class full: ${label}`);
    if (!DRY_RUN && ALERTZY_KEY) {
        const msg = SLOT === "0830"
            ? `⏳ ${label} מלא\nאנסה ב-09:30 בשעה 21:30...`
            : `⏳ ${label} מלא — הירשמי ידנית להמתנה`;
        await sendPushNotification(ALERTZY_KEY, "⏳ שיעור מלא", msg);
    }
    process.exit(0);
}

const result = await enroll(cls, token, refreshToken);

if (result.ok) {
    console.log(`Enrolled! ${label}`);
    if (!DRY_RUN && ALERTZY_KEY) {
        await sendPushNotification(ALERTZY_KEY, "✅ נרשמת!", `✅ ${label}`);
    }
} else {
    const rawReason = result.data?.error?.messageToUser || result.data?.message;
    const reason = Array.isArray(rawReason)
        ? rawReason[0]?.message || JSON.stringify(rawReason[0])
        : typeof rawReason === "string" ? rawReason : JSON.stringify(rawReason);
    console.log(`Enrollment failed: ${reason}`);
    if (!DRY_RUN && ALERTZY_KEY) {
        await sendPushNotification(ALERTZY_KEY, "❌ הרישום נכשל", `❌ ${label}\n${reason}`);
    }
}

console.log("Done!");
process.exit(0);
