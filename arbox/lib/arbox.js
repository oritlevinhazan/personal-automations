import { Cron } from "croner";
import { addDays, format, subSeconds } from "date-fns";
import fetch from "node-fetch";

import { sendPushNotification } from "../../shared/push-notification.js";
import { scheduleClasses } from "../data/schedule.js";
import config from "../data/config.js";
const {
	user_creds,
	registerTime: REGISTER_TIME,
	remindersTime,
	maxClassesPerMonth,
	timezone: TIMEZONE,
	coach_priorities: COACH_PRIORITIES,
	alertzyAccountKey,
} = config;

// global vars
let jobs = [];

let user = {
	creds: {
		email: user_creds.email,
		password: user_creds.password,
	},
	id: undefined,
	token: "",
	refreshToken: "",
	membership_id: undefined,
};

export const loginArbox = async () => {
	try {
		const response = await fetch(
			"https://apiappv2.arboxapp.com/api/v2/user/login",
			{
				method: "POST",
				headers: {
					Accept: "application/json, text/plain, */*",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(user.creds),
			}
		);

		if (response.status !== 200) {
			const errorBody = await response.text();
			throw new Error(`Login HTTP ${response.status}: ${errorBody}`);
		}

		const responseData = await response.json();

		user = {
			...user,
			...responseData.data,
			membership_id: 13327706,
		};

		console.log("User logged in succesfully.");
	} catch (e) {
		console.log("Login failed.");
		throw e;
	}
};

export const createEnrollmentJobs = async (onlyDays = null) => {
	if (!user.token) await loginArbox();

	let schedule = onlyDays
		? scheduleClasses.filter((c) => onlyDays.includes(c.dayOfWeek))
		: scheduleClasses;

	console.log("Desired schedule: ", schedule);

	const getNextDateForDay = (dayOfWeek) => {
		const today = new Date();
		const daysUntil = (dayOfWeek - today.getDay() + 7) % 7 || 7;
		return format(addDays(today, daysUntil), "yyyy-MM-dd");
	};

	// fetch all unique days in parallel
	const uniqueDays = [...new Set(schedule.map((c) => c.dayOfWeek))];
	const scheduleByDay = {};
	await Promise.all(
		uniqueDays.map(async (day) => {
			const date = getNextDateForDay(day);
			const boxSchedule = await getArboxScheduleByDate(date);
			if (boxSchedule === null || boxSchedule === undefined) {
				console.log("Could not fetch schedule for " + date);
			} else if (boxSchedule.length === 0) {
				console.log("Schedule not published yet for " + date);
				scheduleByDay[day] = { date, boxSchedule, notPublished: true };
			} else {
				scheduleByDay[day] = { date, boxSchedule, notPublished: false };
			}
		})
	);

	const daysWithJobs = new Set();

	for (const classObj of schedule) {
		const dayData = scheduleByDay[classObj.dayOfWeek];
		if (!dayData) continue;

		const { date: nextDate, boxSchedule } = dayData;

		let optionalClasses = [];
		for (const boxClass of boxSchedule) {
			if (
				boxClass.time === classObj.start_time &&
				boxClass.box_categories.name.trim() === classObj.class_name
			) {
				optionalClasses.push(boxClass);
			}
		}

		if (optionalClasses.length === 0) {
			console.log(
				"no matching classes found for the time " + classObj.start_time
			);
			continue;
		}

		console.log("[DEBUG] matched class sample:", JSON.stringify(optionalClasses[0], null, 2));
		let selected_class = optionalClasses[0];
		outer: for (const coach of COACH_PRIORITIES) {
			for (const currClass of optionalClasses) {
				if (currClass.coach && coach === currClass.coach.full_name) {
					selected_class = currClass;
					break outer;
				}
			}
		}

		const newJob = {
			extras: null,
			membership_user_id: user.membership_id,
			schedule_id: selected_class.id,
			workoutDetails: { ...classObj, date: nextDate },
		};
		addJob(newJob);
		daysWithJobs.add(classObj.dayOfWeek);
	}

	return {
		notPublished: uniqueDays.filter((d) => scheduleByDay[d]?.notPublished && !daysWithJobs.has(d)),
		notFound: uniqueDays.filter((d) => !scheduleByDay[d] || (!scheduleByDay[d].notPublished && !daysWithJobs.has(d))),
		missingDays: uniqueDays.filter((d) => !daysWithJobs.has(d)),
	};
};

const getBoxLocationsIdFirst = async (token) => {
	try {
		const response = await fetch(
			"https://apiappv2.arboxapp.com/api/v2/boxes/locations",
			{
				method: "GET",
				headers: {
					Accept: "application/json, text/plain, */*",
					"Content-Type": "application/json",
					accesstoken: token,
				},
			}
		);

		if (response.status !== 200) {
			throw new Error();
		}
		const responseData = await response.json();
		return responseData;
	} catch (e) {
		console.log("Issue with getting arbox locations.");
	}
};

const getArboxScheduleByDate = async (date) => {
	const date_normalized = date + "T00:00:00.000Z";

	const locationsData = await getBoxLocationsIdFirst(user.token);
	const allLocations = locationsData?.data?.flatMap(box => box.locations_box) || [];
	const myLocation = allLocations.find(loc => loc.id === 21697);
	const locationsBoxId = myLocation?.id;

	const info = {
		from: date_normalized,
		locations_box_id: locationsBoxId,
		to: date_normalized,
	};

	try {
		const response = await fetch(
			"https://apiappv2.arboxapp.com/api/v2/schedule/betweenDates",
			{
				method: "POST",
				headers: {
					Accept: "application/json, text/plain, */*",
					"Content-Type": "application/json",
					accesstoken: user.token,
					refreshtoken: user.refreshToken,
				},
				body: JSON.stringify(info),
			}
		);

		if (response.status !== 200) {
			throw new Error();
		}

		return (await response.json()).data;
	} catch (e) {
		console.log("Issue with getting a schedule.");
	}
};

const addJob = (newJobData) => {
	for (const currJob of jobs) {
		if (
			currJob.membership_user_id === newJobData.membership_user_id &&
			currJob.schedule_id === newJobData.schedule_id
		) {
			console.log("Job exist");
			return;
		}
	}
	jobs.push(newJobData);
};

const emptyJobsList = () => {
	jobs = [];
};

export const envokeJobs = async (dryRun = false) => {
	const succeeded = [];
	const failed = [];
	const hadJobs = jobs.length > 0;

	for (const currJob of jobs) {
		if (dryRun) {
			console.log(
				`[DRY RUN] Would enroll in [${currJob.workoutDetails.class_name}] at ${currJob.workoutDetails.start_time} on ${currJob.workoutDetails.date}`
			);
			continue;
		}

		try {
			const detailsForRegistration = {
				extras: currJob.extras,
				membership_user_id: currJob.membership_user_id,
				schedule_id: currJob.schedule_id,
			};

			const response = await fetch(
				"https://apiappv2.arboxapp.com/api/v2/scheduleUser/insert",
				{
					method: "POST",
					headers: {
						Accept: "application/json, text/plain, */*",
						"Content-Type": "application/json",
						accesstoken: user.token,
						refreshtoken: user.refreshToken,
					},
					body: JSON.stringify(detailsForRegistration),
				}
			);
			const responseData = await response.json();
			const label = `${currJob.workoutDetails.class_name} ${currJob.workoutDetails.start_time} (${currJob.workoutDetails.date})`;

			if (response.status === 200) {
				console.log("Enrolled succesfully! 🥳");
				succeeded.push(label);
			} else {
				const rawReason = responseData.error?.messageToUser || responseData.message;
				const reason = Array.isArray(rawReason)
					? rawReason[0]?.message || JSON.stringify(rawReason[0])
					: typeof rawReason === "string"
					? rawReason
					: JSON.stringify(rawReason);
				console.log(reason);
				failed.push(`${label}: ${reason}`);
			}
		} catch (e) {
			console.log("Issue with enrolling to specific class.");
			failed.push(`${currJob.workoutDetails.class_name} ${currJob.workoutDetails.start_time}: error`);
		}
	}
	emptyJobsList();

	if (!dryRun && hadJobs && alertzyAccountKey) {
		const title = succeeded.length > 0 ? "✅ נרשמת לשיעורים!" : "❌ הרישום נכשל";
		const lines = [
			...succeeded.map(s => `✅ ${s}`),
			...failed.map(f => `❌ ${f}`),
		];
		const message = lines.join("\n") || "לא נמצאו שיעורים להרשמה";
		await sendPushNotification(alertzyAccountKey, title, message);
	}

	return { succeeded, failed };
};

const pushReminders = async () => {
	try {
		await loginArbox();
		const response = await fetch(
			"https://apiappv2.arboxapp.com/api/v2/user/feed",
			{
				method: "GET",
				headers: {
					Accept: "application/json, text/plain, */*",
					"Content-Type": "application/json",
					accesstoken: user.token,
					refreshtoken: user.refreshToken,
				},
			}
		);
		const responseData = await response.json();

		const pastEnrolls =
			Number(responseData.scheduleUserStatus.results.past) || 0;
		const futureEnrolls =
			Number(responseData.scheduleUserStatus.results.future) || 0;
		const numRegistrations = pastEnrolls + futureEnrolls;
		const numClassesLeft = maxClassesPerMonth - numRegistrations;
		const dayOfMonth = format(new Date(), "d", { timezone: TIMEZONE });

		if (numClassesLeft <= 2 && dayOfMonth >= 28) {
			const strReachedQuota =
				numClassesLeft === 0
					? "You've reached quota! 🙈"
					: "Almost reached quota! 🙈";

			console.log(
				`${strReachedQuota} Registered (incl future): ${numRegistrations}, Left: ${numClassesLeft}`
			);
		}
	} catch (e) {
		console.log("Issue with sending reminder.");
	}
};

const getCronTime = (time) => {
	const timeHours = time.substring(0, 2);
	const timeMin = time.substring(3, 5);
	const timeSec = time.substring(6, 8);
	return `${timeSec} ${timeMin} ${timeHours}`;
};

export const scheduler = async () => {
	console.log(
		"Waiting for the right time to start enrolling [" + REGISTER_TIME + "]🧭"
	);

	const registerTimeHours = REGISTER_TIME.substring(0, 2);
	const registerTimeMin = REGISTER_TIME.substring(3, 5);
	const registerTimeSec = REGISTER_TIME.substring(6, 8);

	const CUT_SECONDS = 30;
	const cutTime = format(
		subSeconds(
			new Date(
				0,
				0,
				0,
				Number(registerTimeHours),
				Number(registerTimeMin),
				Number(registerTimeSec)
			),
			CUT_SECONDS
		),
		"ss mm HH"
	);

	Cron(`${cutTime} * * *`, { timezone: TIMEZONE }, async () => {
		console.log(
			"[Preparing Jobs] Preparing classes info [uptime: " +
				process.uptime() +
				"]"
		);
		await createEnrollmentJobs();
	});

	Cron(
		`${registerTimeSec} ${registerTimeMin} ${registerTimeHours} * * *`,
		{ timezone: TIMEZONE },
		async () => {
			console.log(
				"[Jobs Executer] Enrolling classes [uptime: " + process.uptime() + "]"
			);
			await envokeJobs(false);
		}
	);

	Cron(
		`${getCronTime(remindersTime)} * * *`,
		{ timezone: TIMEZONE },
		async () => {
			console.log("[Reminder] Sending push notification");
			await pushReminders();
		}
	);
};
