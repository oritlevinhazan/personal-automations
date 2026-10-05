#!/usr/bin/env python3
"""
Career Scout Daily — checks all target companies for new DA roles.
Sends Alertzy push notification + email report for new openings.
"""

import asyncio
import json
import os
import smtplib
import requests
from datetime import date
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

try:
    from playwright.async_api import async_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False
    print("WARNING: playwright not installed — custom/Workday sites will be skipped")

BASE_DIR = Path(__file__).parent
COMPANIES_FILE = BASE_DIR / "companies.json"
KNOWN_ROLES_FILE = BASE_DIR / "known_roles.json"


# ─────────────────────────────────────────
# Config loading
# ─────────────────────────────────────────

def load_config():
    with open(COMPANIES_FILE) as f:
        data = json.load(f)
    return data["companies"], data["candidate"]


def load_known_roles():
    with open(KNOWN_ROLES_FILE) as f:
        return json.load(f)


def save_known_roles(data):
    with open(KNOWN_ROLES_FILE, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


# ─────────────────────────────────────────
# Job fetchers
# ─────────────────────────────────────────

def fetch_greenhouse_jobs(slug: str) -> list[dict]:
    """Public Greenhouse API — no auth needed."""
    url = f"https://api.greenhouse.io/v1/boards/{slug}/jobs"
    try:
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        data = r.json()
        return [
            {
                "title": job["title"],
                "url": job["absolute_url"],
                "location": job.get("location", {}).get("name", ""),
                "description": "",
            }
            for job in data.get("jobs", [])
        ]
    except Exception as e:
        print(f"  Greenhouse API error ({slug}): {e}")
        return []


def fetch_lever_jobs(slug: str) -> list[dict]:
    """Public Lever API — no auth needed."""
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    try:
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        data = r.json()
        return [
            {
                "title": job["text"],
                "url": job["hostedUrl"],
                "location": job.get("categories", {}).get("location", ""),
                "description": job.get("descriptionPlain", "")[:2000],
            }
            for job in data
        ]
    except Exception as e:
        print(f"  Lever API error ({slug}): {e}")
        return []


async def scrape_playwright_jobs(company: dict) -> list[dict]:
    """Generic Playwright scraper — load careers page, extract job title links."""
    if not PLAYWRIGHT_AVAILABLE:
        return []

    url = company["careers_url"]
    print(f"  Playwright: {url}")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox"],
        )
        page = await browser.new_page()

        try:
            await page.goto(url, wait_until="networkidle", timeout=40000)

            if company.get("ats") == "workday":
                await _workday_search(page, company)
            else:
                # Extra wait for JS-heavy SPAs
                await page.wait_for_timeout(3000)

            # Extract all anchor links that could be job titles
            jobs = await page.evaluate("""
                () => Array.from(document.querySelectorAll('a[href]'))
                    .map(a => ({
                        text: (a.innerText || a.textContent || '').trim().replace(/\\s+/g, ' '),
                        href: a.href
                    }))
                    .filter(j => j.text.length > 5 && j.text.length < 150 && j.href.length > 0)
            """)

            return [
                {
                    "title": j["text"],
                    "url": j["href"],
                    "location": "",
                    "description": "",
                }
                for j in jobs
            ]

        except Exception as e:
            print(f"  Playwright error ({company['name']}): {e}")
            return []
        finally:
            await browser.close()


async def _workday_search(page, company: dict):
    """Navigate Workday to search for analyst roles in Israel."""
    workday_url = company.get("workday_url", company["careers_url"])
    try:
        # Workday supports ?q= query parameter
        search_url = f"{workday_url}?q=analyst&locationCountry=ISR"
        await page.goto(search_url, wait_until="networkidle", timeout=40000)
        await page.wait_for_timeout(4000)
    except Exception as e:
        print(f"  Workday search fallback: {e}")


# ─────────────────────────────────────────
# Role filtering and scoring
# ─────────────────────────────────────────

def is_relevant_role(title: str, candidate: dict) -> bool:
    """Check title against candidate's include/exclude lists."""
    t = title.lower()
    has_include = any(kw in t for kw in candidate["title_include"])
    has_exclude = any(kw in t for kw in candidate["title_exclude"])
    return has_include and not has_exclude


def score_role_fit(title: str, description: str, candidate: dict) -> float:
    """
    Score 0-10 for how well this role fits the candidate's skills and background.
    Based on keyword matching — higher is better.
    """
    text = (title + " " + description).lower()
    score = 5.0

    # SQL is required — her core skill
    if "sql" in text:
        score += 1.5

    # Strong tools (she has these)
    for skill, pts in [
        ("tableau", 1.0),
        ("snowflake", 0.8),
        ("dbt", 0.7),
        ("google analytics", 0.6),
        ("ga4", 0.6),
        ("mixpanel", 0.5),
        ("amplitude", 0.5),
        ("redshift", 0.4),
        ("looker", 0.4),
    ]:
        if skill in text:
            score += pts

    # Good-to-have tools (she has some)
    for skill in [
        "salesforce", "hubspot", "marketo", "google ads", "facebook ads",
        "meta ads", "appsflyer", "attribution", "bigquery",
    ]:
        if skill in text:
            score += 0.3

    # Python — she's learning; penalize if explicitly required
    python_hard_req = any(kw in text for kw in [
        "python required", "python is required", "must know python",
        "strong python", "proficient in python", "python mandatory",
        "python - must", "python – must", "python experience required",
    ])
    if python_hard_req:
        score -= 2.0
    elif "python" in text and not any(kw in text for kw in [
        "advantage", "plus", "preferred", "nice to have", "bonus", "optional",
    ]):
        score -= 0.5  # mentioned without clear "optional" signal

    # Domain bonuses — her background is marketing/product analytics
    if any(kw in text for kw in [
        "marketing analytics", "marketing analyst", "performance marketing",
        "growth analytics", "user acquisition", "paid media", "attribution model",
        "campaign analytics", "media analytics", "gtm analytics", "go-to-market",
        "revenue analytics", "b2b analytics",
    ]):
        score += 1.5

    if any(kw in text for kw in [
        "product analytics", "product analyst", "user behavior", "funnel analysis",
    ]):
        score += 0.5

    # Domain penalties — domains far from her background
    if any(kw in text for kw in ["risk analytics", "fraud", "aml", "anti-money", "compliance analytics"]):
        score -= 1.5

    if any(kw in text for kw in ["fp&a", "financial planning", "treasury", "accounting analytics"]):
        score -= 1.0

    # Seniority signals
    if any(kw in title.lower() for kw in ["senior", "sr.", "sr "]):
        score += 0.5
    if any(kw in title.lower() for kw in ["manager", "director", "head of", "vp "]):
        score -= 1.0  # management track

    return round(min(10.0, max(1.0, score)), 1)


def compute_career_scout_score(company: dict, role_fit: float) -> dict:
    """
    Career Scout formula: Growth×30% + Equity×25% + Role Fit×25% + Culture×20%
    Caps at 5.0 for red flags.
    """
    s = company["scores"]
    growth = s["growth"]
    equity = s["equity"]
    culture = s["culture"]

    total = (growth * 0.30) + (equity * 0.25) + (role_fit * 0.25) + (culture * 0.20)

    # Red flag caps
    cap_reasons = []
    if s.get("glassdoor_il", 5.0) < 3.0:
        cap_reasons.append(f"Glassdoor {s['glassdoor_il']:.1f} < 3.0")
    if equity <= 2:
        cap_reasons.append("Stock/equity red flag")
    # Check for 3+ layoff rounds in layoff_history text
    layoff_text = s.get("layoff_history", "").lower()
    if any(phrase in layoff_text for phrase in ["3 rounds", "third round", "multiple rounds"]):
        cap_reasons.append("3+ layoff rounds")

    if cap_reasons:
        total = min(total, 5.0)

    return {
        "growth": growth,
        "equity": equity,
        "role_fit": role_fit,
        "culture": culture,
        "total": round(total, 2),
        "capped": cap_reasons,
    }


# ─────────────────────────────────────────
# New role detection
# ─────────────────────────────────────────

def find_new_roles(current_roles: list[dict], known: dict) -> list[dict]:
    """Return roles not in known_roles.json (match by URL or company+title pair)."""
    known_urls = {r["url"].rstrip("/") for r in known.get("known_roles", [])}
    known_pairs = {
        (r["company"].lower(), r["title"].lower())
        for r in known.get("known_roles", [])
    }

    new = []
    for role in current_roles:
        url_known = role["url"].rstrip("/") in known_urls
        pair_known = (role["company"].lower(), role["title"].lower()) in known_pairs
        if not url_known and not pair_known:
            new.append(role)
    return new


# ─────────────────────────────────────────
# Reporting
# ─────────────────────────────────────────

def format_html_report(new_roles: list[dict], run_date: str) -> str:
    """Generate Career Scout HTML email report."""
    cards = []
    for role in sorted(new_roles, key=lambda r: r["score"], reverse=True):
        s = role["scores"]
        score_color = "#00a651" if s["total"] >= 7 else "#f5a623" if s["total"] >= 5 else "#e74c3c"
        cap_note = f"<br><span style='color:#e74c3c;font-size:12px;'>⚠ CAPPED — {', '.join(s['capped'])}</span>" if s["capped"] else ""

        cards.append(f"""
<div style="border:1px solid #e0e0e0;border-radius:10px;padding:24px;margin:16px 0;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.06);">
  <h2 style="margin:0 0 4px 0;color:#1a1a2e;font-size:20px;">{role['company']} — {role['title']}</h2>
  <div style="font-size:32px;font-weight:bold;color:{score_color};margin:4px 0;">
    {s['total']:.2f}<span style="font-size:16px;color:#999;">/10</span>{cap_note}
  </div>
  <p style="color:#666;margin:4px 0 16px 0;">📍 {role.get('address_israel', 'Israel')}</p>

  <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
    <tr style="background:#f8f9fa;">
      <td style="padding:8px 12px;font-weight:600;">📈 Growth</td>
      <td style="padding:8px 12px;">{s['growth']}/10</td>
      <td style="padding:8px 12px;color:#999;font-size:12px;">weight 30%</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;font-weight:600;">💰 Equity</td>
      <td style="padding:8px 12px;">{s['equity']}/10</td>
      <td style="padding:8px 12px;color:#999;font-size:12px;">weight 25%</td>
    </tr>
    <tr style="background:#f8f9fa;">
      <td style="padding:8px 12px;font-weight:600;">🎯 Role Fit</td>
      <td style="padding:8px 12px;">{s['role_fit']}/10</td>
      <td style="padding:8px 12px;color:#999;font-size:12px;">weight 25%</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;font-weight:600;">🏢 Culture</td>
      <td style="padding:8px 12px;">{s['culture']}/10</td>
      <td style="padding:8px 12px;color:#999;font-size:12px;">weight 20%</td>
    </tr>
  </table>

  <p style="font-size:13px;color:#555;margin:0 0 16px 0;">
    <strong>Layoff history:</strong> {role.get('layoff_history', 'No major layoffs reported')}
  </p>

  <a href="{role['url']}" style="display:inline-block;background:#0052cc;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">
    Apply Now →
  </a>
</div>""")

    return f"""<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f2f5;padding:20px;margin:0;">
<div style="max-width:680px;margin:0 auto;">
  <div style="background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;padding:28px;border-radius:10px;margin-bottom:16px;">
    <h1 style="margin:0;font-size:24px;">🔍 Career Scout Daily Report</h1>
    <p style="margin:6px 0 0 0;opacity:.8;font-size:14px;">{run_date} · {len(new_roles)} new role{'s' if len(new_roles) != 1 else ''} found</p>
  </div>
  {''.join(cards)}
  <p style="text-align:center;color:#aaa;font-size:12px;margin-top:24px;">
    Career Scout · Automated daily scan · Roles scored using Growth/Equity/Role Fit/Culture formula
  </p>
</div>
</body>
</html>"""


def send_alertzy(new_roles: list[dict], api_key: str):
    """Send brief push notification via Alertzy."""
    count = len(new_roles)
    top = new_roles[0]

    title = f"Career Scout: {count} new role{'s' if count > 1 else ''}"
    body = f"{top['company']}: {top['title']} ({top['score']:.2f}/10)"
    if count > 1:
        others = ", ".join(r["company"] for r in new_roles[1:3])
        body += f"\n+ {count - 1} more: {others}"

    try:
        r = requests.post(
            "https://alertzy.app/send",
            data={"accountKey": api_key, "title": title, "body": body},
            timeout=10,
        )
        print(f"Alertzy: {'sent OK' if r.status_code == 200 else f'error {r.status_code}: {r.text}'}")
    except Exception as e:
        print(f"Alertzy error: {e}")


def send_email(html_body: str, new_roles: list[dict], run_date: str,
               from_addr: str, to_addr: str, password: str):
    """Send HTML report via Gmail SMTP."""
    count = len(new_roles)
    subject = f"Career Scout: {count} new role{'s' if count != 1 else ''} — {run_date}"

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(from_addr, password)
            server.sendmail(from_addr, to_addr, msg.as_string())
        print(f"Email sent to {to_addr}")
    except Exception as e:
        print(f"Email error: {e}")


# ─────────────────────────────────────────
# Main
# ─────────────────────────────────────────

async def check_company(company: dict, candidate: dict) -> list[dict]:
    """Check one company and return scored, filtered roles."""
    print(f"\n[{company['name']}] ats={company['ats']}")

    ats = company["ats"]

    if ats == "greenhouse" and company.get("greenhouse_slug"):
        raw_jobs = fetch_greenhouse_jobs(company["greenhouse_slug"])
    elif ats == "lever" and company.get("lever_slug"):
        raw_jobs = fetch_lever_jobs(company["lever_slug"])
    else:
        raw_jobs = await scrape_playwright_jobs(company)

    print(f"  {len(raw_jobs)} total links scraped")

    relevant = [j for j in raw_jobs if is_relevant_role(j["title"], candidate)]
    print(f"  {len(relevant)} pass title filter")

    scored = []
    for job in relevant:
        role_fit = score_role_fit(job["title"], job.get("description", ""), candidate)
        career_scores = compute_career_scout_score(company, role_fit)
        scored.append({
            "company": company["name"],
            "title": job["title"],
            "url": job["url"],
            "location": job.get("location", "Israel"),
            "score": career_scores["total"],
            "scores": career_scores,
            "address_israel": company.get("address_israel", "Israel"),
            "layoff_history": company["scores"].get("layoff_history", ""),
            "found_date": str(date.today()),
        })

    return scored


async def main():
    today = str(date.today())
    print(f"=== Career Scout Daily: {today} ===")

    companies, candidate = load_config()
    known = load_known_roles()

    all_current: list[dict] = []
    for company in companies:
        try:
            roles = await check_company(company, candidate)
            all_current.extend(roles)
        except Exception as e:
            print(f"  ERROR processing {company['name']}: {e}")

    print(f"\n=== {len(all_current)} relevant role(s) found across all companies ===")

    new_roles = find_new_roles(all_current, known)
    print(f"=== {len(new_roles)} NEW role(s) not seen before ===")

    for role in sorted(new_roles, key=lambda r: r["score"], reverse=True):
        print(f"  ★ {role['company']}: {role['title']} ({role['score']:.2f}/10)")

    # Persist new roles into known_roles.json
    updated_known = {
        "last_run": today,
        "known_roles": known.get("known_roles", []) + [
            {
                "company": r["company"],
                "title": r["title"],
                "url": r["url"],
                "found_date": r["found_date"],
                "status": "open",
            }
            for r in new_roles
        ],
    }
    save_known_roles(updated_known)
    print(f"known_roles.json updated ({len(updated_known['known_roles'])} total)")

    if not new_roles:
        print("No new roles — skipping notifications.")
        return

    alertzy_key = os.environ.get("ALERTZY_KEY")
    if alertzy_key:
        send_alertzy(new_roles, alertzy_key)
    else:
        print("ALERTZY_KEY not set — skipping push notification")

    email_from = os.environ.get("EMAIL_FROM")
    email_to = os.environ.get("EMAIL_TO")
    email_password = os.environ.get("EMAIL_PASSWORD")

    if email_from and email_to and email_password:
        html = format_html_report(new_roles, today)
        send_email(html, new_roles, today, email_from, email_to, email_password)
    else:
        print("Email env vars not set — skipping email")

    print("\nDone.")


if __name__ == "__main__":
    asyncio.run(main())
