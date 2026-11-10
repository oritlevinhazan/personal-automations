// Read-only: prints, for the next Sun/Tue/Thu, which class the user is booked into and which
// strength/power classes exist (time, free places). Used by the post-enrollment checker agent.
import dotenv from "dotenv";
dotenv.config();
import { addDays, format } from "date-fns";

const H = { Accept: "application/json", "Content-Type": "application/json" };
const login = await (await fetch("https://apiappv2.arboxapp.com/api/v2/user/login", {
  method: "POST", headers: H,
  body: JSON.stringify({ email: process.env.ARBOX_USER_EMAIL, password: process.env.ARBOX_USER_PASSWORD }),
})).json();
const auth = { ...H, accesstoken: login.data.token, refreshtoken: login.data.refreshToken };

const out = [];
for (const day of [0, 2, 4]) {
  const today = new Date();
  const date = format(addDays(today, (day - today.getDay() + 7) % 7 || 7), "yyyy-MM-dd");
  const d = date + "T00:00:00.000Z";
  const res = await (await fetch("https://apiappv2.arboxapp.com/api/v2/schedule/betweenDates", {
    method: "POST", headers: auth,
    body: JSON.stringify({ from: d, to: d, locations_box_id: 21697 }),
  })).json();
  const classes = res.data || [];
  const rel = classes.filter((c) => /strength|power/i.test(c.box_categories?.name || ""));
  out.push({
    day, date,
    published: classes.length > 0,
    booked: rel.filter((c) => c.user_booked).map((c) => `${c.time} ${c.box_categories.name.trim()}`),
    waitlisted: rel.filter((c) => c.user_in_standby).map((c) => `${c.time} ${c.box_categories.name.trim()}`),
    // only non-personal info: time, name, free places
    strengthPowerClasses: rel.map((c) => ({ time: c.time, name: c.box_categories.name.trim(), free: c.free })),
  });
}
console.log(JSON.stringify(out, null, 2));
