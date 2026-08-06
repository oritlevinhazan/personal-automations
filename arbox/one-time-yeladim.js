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

// Next week: Sun Aug 9 – Sat Aug 15
const DATES = ["2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15"];

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

const isEnrolled = (cls) => cls?.schedule_user?.some(u => u.membership_user_fk === MEMBERSHIP_ID);

const enroll = async (cls, date, token, refreshToken) => {
    const label = `${cls.box_categories.name} ${cls.time} (${date})`;
    if (DRY_RUN) {
        console.log(`[DRY RUN] Would enroll in: ${label}`);
        return { ok: true, label };
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
    return { ok: res.status === 200, label, data };
};

console.log("One-time ילדים enrollment — next week (Aug 9–15)");
const { token, refreshToken } = await login();

// Fetch all schedules in parallel — isolate failures per day
const schedules = await Promise.all(
    DATES.map(date =>
        getSchedule(date, token, refreshToken)
            .then(s => ({ date, schedule: s }))
            .catch(e => { console.log(`${date}: failed to fetch schedule — ${e.message}`); return null; })
    )
);

// Collect all ילדים classes across all days
const allClasses = schedules.filter(Boolean).flatMap(({ date, schedule }) => {
    const yeladimClasses = schedule.filter(cls => cls.box_categories?.name?.includes("ילדים"));
    if (yeladimClasses.length === 0) console.log(`${date}: no ילדים classes found`);
    return yeladimClasses.map(cls => ({ cls, date }));
});

// Enroll in all in parallel
const results = await Promise.all(allClasses.map(async ({ cls, date }) => {
    const label = `${cls.box_categories.name} ${cls.time} (${date})`;

    if (isEnrolled(cls)) {
        console.log(`Already enrolled: ${label}`);
        return { type: "skipped", label };
    }

    if (cls.free <= 0) {
        console.log(`Full: ${label}`);
        return { type: "failed", label: `${label}: מלא` };
    }

    const result = await enroll(cls, date, token, refreshToken);
    if (result.ok) {
        console.log(`Enrolled: ${label}`);
        return { type: "succeeded", label };
    }

    const rawReason = result.data?.error?.messageToUser || result.data?.message;
    const reason = Array.isArray(rawReason)
        ? rawReason[0]?.message || JSON.stringify(rawReason[0])
        : typeof rawReason === "string" ? rawReason : JSON.stringify(rawReason);
    console.log(`Failed: ${label} — ${reason}`);
    return { type: "failed", label: `${label}: ${reason}` };
}));

const succeeded = results.filter(r => r.type === "succeeded").map(r => r.label);
const failed = results.filter(r => r.type === "failed").map(r => r.label);
const skipped = results.filter(r => r.type === "skipped").map(r => r.label);

console.log(`Done. Enrolled: ${succeeded.length}, failed: ${failed.length}, skipped: ${skipped.length}`);

if (!DRY_RUN && ALERTZY_KEY) {
    const lines = [];
    for (const s of succeeded) lines.push(`✅ ${s}`);
    for (const f of failed) lines.push(`❌ ${f}`);
    for (const s of skipped) lines.push(`⏭️ כבר רשומה: ${s}`);

    const title = succeeded.length > 0 ? "✅ רישום ילדים הסתיים" : "❌ רישום ילדים הסתיים";
    await sendPushNotification(ALERTZY_KEY, title, lines.join("\n") || "לא נמצאו שיעורי ילדים");
}

process.exit(0);
