import dotenv from "dotenv";
dotenv.config();

import fetch from "node-fetch";
import { sendPushNotification } from "../shared/push-notification.js";

const EMAIL = process.env.ARBOX_USER_EMAIL;
const PASSWORD = process.env.ARBOX_USER_PASSWORD;
const ALERTZY_KEY = process.env.ALERTZY_ACCOUNT_KEY;
const DRY_RUN = process.env.DRY_RUN === "true";
const MEMBERSHIP_ID = 13327706;
const LOCATION_ID = 21697;
const BASE_URL = "https://apiappv2.arboxapp.com/api/v2";

const DATE = "2026-09-08";
const DAY_LABEL = "שלישי 8.9";
// 11:00 first priority, 10:00 fallback
const TIMES = ["11:00", "10:00"];

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

const getSchedule = async (token, refreshToken) => {
    const res = await fetch(`${BASE_URL}/schedule/betweenDates`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            accesstoken: token,
            refreshtoken: refreshToken,
        },
        body: JSON.stringify({
            from: `${DATE}T00:00:00.000Z`,
            locations_box_id: LOCATION_ID,
            to: `${DATE}T00:00:00.000Z`,
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

const isEnrolled = (cls) => cls?.schedule_user?.some(u => u.membership_user_fk === MEMBERSHIP_ID);

const enroll = async (cls, token, refreshToken) => {
    if (DRY_RUN) {
        console.log(`[DRY RUN] Would enroll in: ${cls.box_categories.name} at ${cls.time} on ${DATE}`);
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

console.log(`One-time Sep 8 enrollment — ${DAY_LABEL}, trying: ${TIMES.join(", ")}`);
const { token, refreshToken } = await login();
const schedule = await getSchedule(token, refreshToken);

for (const time of TIMES) {
    const cls = findClass(schedule, time);

    if (!cls) {
        console.log(`No strength/power class found at ${time} — skipping.`);
        continue;
    }

    if (isEnrolled(cls)) {
        console.log(`Already enrolled at ${time} — done.`);
        process.exit(0);
    }

    if (cls.free <= 0) {
        console.log(`Class full at ${time} — trying next slot...`);
        continue;
    }

    const label = `${cls.box_categories.name} ${time} (${DAY_LABEL})`;
    const result = await enroll(cls, token, refreshToken);

    if (result.ok) {
        console.log(`Enrolled! ${label}`);
        if (!DRY_RUN && ALERTZY_KEY) {
            await sendPushNotification(ALERTZY_KEY, "✅ נרשמת!", `✅ ${label}`);
        }
        process.exit(0);
    }

    const rawReason = result.data?.error?.messageToUser || result.data?.message;
    const reason = Array.isArray(rawReason)
        ? rawReason[0]?.message || JSON.stringify(rawReason[0])
        : typeof rawReason === "string" ? rawReason : JSON.stringify(rawReason);
    console.log(`Enrollment failed at ${time}: ${reason}`);
    if (!DRY_RUN && ALERTZY_KEY) {
        await sendPushNotification(ALERTZY_KEY, "❌ הרישום נכשל", `❌ ${label}\n${reason}`);
    }
    process.exit(0);
}

console.log("All slots exhausted — no enrollment made.");
if (!DRY_RUN && ALERTZY_KEY) {
    await sendPushNotification(ALERTZY_KEY, "⏳ כל השיעורים מלאים", `כל השיעורים מלאים (11:00, 10:00) — ${DAY_LABEL}\nהירשמי ידנית להמתנה`);
}
process.exit(0);
