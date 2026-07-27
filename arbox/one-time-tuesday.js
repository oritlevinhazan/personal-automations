import dotenv from "dotenv";
dotenv.config();

import fetch from "node-fetch";
import { sendPushNotification } from "../shared/push-notification.js";

const EMAIL = process.env.ARBOX_USER_EMAIL;
const PASSWORD = process.env.ARBOX_USER_PASSWORD;
const ALERTZY_KEY = process.env.ALERTZY_ACCOUNT_KEY;
const SKIP_WAIT = process.env.SKIP_WAIT === "true";
const DRY_RUN = process.env.DRY_RUN === "true";
const MEMBERSHIP_ID = 13327706;
const LOCATION_ID = 21697;
const BASE_URL = "https://apiappv2.arboxapp.com/api/v2";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const getMillisUntil = (timeStr) => {
    const [h, m, s] = timeStr.split(":").map(Number);
    const now = new Date();
    const israelTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
    const target = new Date(israelTime);
    target.setHours(h, m, s, 0);
    if (target <= israelTime) {
        if (israelTime - target < 10 * 60 * 1000) return 0;
        target.setDate(target.getDate() + 1);
    }
    return target - israelTime;
};

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

const findClass = (schedule, time) => {
    for (const cls of schedule) {
        if (cls.time === time) {
            const name = cls.box_categories?.name?.toLowerCase() || "";
            if (name.includes("strength") || name.includes("power")) {
                return cls;
            }
        }
    }
    return null;
};

const enrollInClass = async (cls, token, refreshToken) => {
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
        body: JSON.stringify({
            extras: null,
            membership_user_id: MEMBERSHIP_ID,
            schedule_id: cls.id,
        }),
    });
    const data = await res.json();
    return { ok: res.status === 200, data };
};

const tryAtTime = async (date, time, token, refreshToken) => {
    console.log(`Checking ${time} on ${date}...`);
    const schedule = await getSchedule(date, token, refreshToken);
    const cls = findClass(schedule, time);

    if (!cls) {
        console.log(`No strength/power class found at ${time}`);
        return { status: "notFound", label: time };
    }

    const label = `${cls.box_categories.name} ${time} (${date})`;

    if (cls.free <= 0) {
        console.log(`Class full: ${label}`);
        return { status: "full", label };
    }

    const result = await enrollInClass(cls, token, refreshToken);
    if (result.ok) {
        console.log(`Enrolled! ${label}`);
        return { status: "enrolled", label };
    }

    const rawReason = result.data?.error?.messageToUser || result.data?.message;
    const reason = Array.isArray(rawReason)
        ? rawReason[0]?.message || JSON.stringify(rawReason[0])
        : typeof rawReason === "string"
        ? rawReason
        : JSON.stringify(rawReason);
    console.log(`Enrollment failed: ${reason}`);
    return { status: "failed", label, reason };
};

// Wait until 20:30 Israel time
if (!SKIP_WAIT) {
    const ms = getMillisUntil("20:30:00");
    if (ms > 0) {
        console.log(`Waiting ${Math.round(ms / 1000)}s until 20:30 Israel time...`);
        await wait(ms);
    }
}

console.log("Starting one-time Tuesday enrollment...");
const { token, refreshToken } = await login();
const date = getNextTuesdayDate();
console.log(`Target date: ${date}`);

const attempt1 = await tryAtTime(date, "08:30", token, refreshToken);

let attempt2 = null;
if (attempt1.status === "full") {
    if (!SKIP_WAIT) {
        const ms = getMillisUntil("21:30:00");
        if (ms > 0) {
            console.log(`08:30 is full. Waiting ${Math.round(ms / 1000)}s until 21:30 to try 09:30...`);
            await wait(ms);
        }
    } else {
        console.log("08:30 is full. Trying 09:30...");
    }
    attempt2 = await tryAtTime(date, "09:30", token, refreshToken);
}

if (!DRY_RUN && ALERTZY_KEY) {
    const lines = [];

    if (attempt1.status === "enrolled") lines.push(`✅ נרשמת: ${attempt1.label}`);
    else if (attempt1.status === "full") lines.push(`⏳ מלא — הירשמי ידנית להמתנה: ${attempt1.label}`);
    else if (attempt1.status === "notFound") lines.push(`⚠️ שיעור לא נמצא: ${attempt1.label}`);
    else if (attempt1.status === "failed") lines.push(`❌ נכשל: ${attempt1.label}: ${attempt1.reason}`);

    if (attempt2) {
        if (attempt2.status === "enrolled") lines.push(`✅ נרשמת: ${attempt2.label}`);
        else if (attempt2.status === "full") lines.push(`⏳ מלא — הירשמי ידנית להמתנה: ${attempt2.label}`);
        else if (attempt2.status === "notFound") lines.push(`⚠️ שיעור לא נמצא: ${attempt2.label}`);
        else if (attempt2.status === "failed") lines.push(`❌ נכשל: ${attempt2.label}: ${attempt2.reason}`);
    }

    const enrolled = attempt1.status === "enrolled" || attempt2?.status === "enrolled";
    const title = enrolled ? "✅ הרישום הסתיים" : "❌ הרישום הסתיים";
    await sendPushNotification(ALERTZY_KEY, title, lines.join("\n") || "לא היו שיעורים לרישום");
}

console.log("Done!");
process.exit(0);
