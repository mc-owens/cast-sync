# CastSync

A full-stack web application for dance directors to manage auditions — from collecting dancer submissions to publishing the final cast list.

**Live site:** [cast-sync.com](https://cast-sync.com)

---

## What it does

**For directors:**
- Create organizations and audition seasons
- Invite dancers via a shareable link
- View all submitted auditionees in one place
- Drag dancers into pieces with a visual cast builder
- Detect scheduling conflicts automatically based on dancer availability
- Publish the cast list and send a bulk email to all auditionees at once

**For auditionees:**
- Submit an audition form (availability, technique classes, injuries, conflicts)
- Receive an email confirmation of their submission
- Log back in after casting to see their results

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Database | PostgreSQL |
| Authentication | Sessions, bcrypt, Google OAuth (Passport.js) |
| Payments | Stripe (subscriptions + webhooks + billing portal) |
| Email | Resend |
| Error monitoring | Sentry |
| Deployment | Railway |

---

## Features

- Email/password signup with email verification
- Google OAuth login
- Forgot/reset password (token-based)
- Stripe subscription with 10-day free trial and promo code support
- Drag-and-drop cast builder
- Conflict detection across the master schedule
- Bulk cast list email blast to all auditionees
- Guided onboarding tour for new directors
- Rate limiting on authentication routes
- Admin panel for internal account management

---

## Running locally

```bash
npm install
```

Create a `.env` file with:

```
DATABASE_URL=
SESSION_SECRET=
RESEND_API_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
APP_URL=
```

```bash
npm start
```
