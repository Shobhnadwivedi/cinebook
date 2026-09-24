# Put CineBook online: step by step

Everything below happens in your web browser. You don't need to install anything or type any code.

**Payments:** by default the site runs in **demo payment mode**. Customers go through a real booking and a payment step, but no money moves and you don't need any payment company account. If you later want real payments, see "Optional: switch to Razorpay" at the end.

You will sign up for 3 free websites. Each one does one job:

| Website | Its job | Think of it as |
|---|---|---|
| **GitHub** | Stores your code | A Google Drive for code |
| **Neon** | Stores your data (users, bookings, seats) | The app's notebook that never forgets |
| **Render** | Runs your app 24/7 and gives it a public link | The shop building |

Time: about 40 minutes. You need only **2 values** for Render:

```
DATABASE_URL    = (from Neon, step 2)
ADMIN_PASSWORD  = (you make it up: 8 or more characters, opens your admin panel)
```

Treat both like bank passwords. Never share them or put them in a screenshot.

---

## Step 1: Put the code on GitHub (10 min)

1. Unzip `cinebook-live.zip` (double-click it). You get a folder called `cinebook-live`.
2. Go to https://github.com and sign in.
3. Click the **+** at the top right, then **New repository**.
4. Repository name: `cinebook`. Choose **Public**. Leave everything else as it is. Click **Create repository**.
5. On the next page, click the link **uploading an existing file**.
6. Open the `cinebook-live` folder in Finder. Press `Cmd + A` to select everything inside it (`public`, `src`, `tests`, `package.json`, `package-lock.json`, `README.md`, `GUIDE.md`). Drag all of it into the GitHub page.
7. Wait until every file is listed. Scroll down and click **Commit changes**.

**Check:** your repository page shows the folders `public`, `src`, `tests` and the file `package.json` at the top level. If you see a single `cinebook-live` folder instead, you dragged the folder itself rather than its contents. Delete the repository (Settings, bottom of the page) and repeat from point 3 above.

**Already uploaded an older version?** Open your repository, click **Add file → Upload files**, drag everything from the new `cinebook-live` folder in again, and click **Commit changes**. Files with the same name are replaced. Render notices the change and redeploys by itself within a few minutes.

---

## Step 2: Create the database on Neon (5 min)

1. Go to https://neon.tech and click **Sign up**. Choose **Continue with GitHub**.
2. Create a project. Name: `cinebook`. Region: pick **Asia Pacific (Singapore)**, the closest to India. Click **Create**.
3. You'll see a **Connection string** box. Make sure the **Pooled connection** option is turned on if you see it. Click **Copy**.

It looks like `postgresql://neondb_owner:abc123@ep-something-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`.

Paste it in your notes as **DATABASE_URL**. You don't need to create any tables; the app does that itself on first start.

---

## Step 3: Put the app online with Render (15 min)

1. Go to https://render.com and click **Get Started**. Choose **GitHub** to sign in.
2. Click **New +** (top right), then **Web Service**.
3. If asked, click **Connect GitHub** / **Configure account** and allow Render to see the `cinebook` repository.
4. Pick `cinebook` from the list and click **Connect**.
5. Fill in the form:

| Field | Value |
|---|---|
| Name | `cinebook-yourname` (this becomes your link) |
| Region | **Singapore** (same as Neon, so they talk fast) |
| Branch | `main` |
| Language / Runtime | **Node** |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | **Free** |

6. Scroll to **Environment Variables**. Click **Add Environment Variable** twice and fill in:

| Key | Value |
|---|---|
| `DATABASE_URL` | your Neon connection string |
| `ADMIN_PASSWORD` | your admin password (8 or more characters) |

Do **not** add any `RAZORPAY_...` variables. Without them the site uses demo payments.

(If you already created the service, add these later under your service → **Environment** → **Save Changes**.)

7. Click **Deploy Web Service**.

You'll see a log scrolling. After 2 to 4 minutes, look for these lines:

```
Empty database: added sample theatres, movies and shows.
CineBook running on port 10000 (DEMO payments)
```

and a green **Live** badge. Your link is at the top, like `https://cinebook-yourname.onrender.com`. Save it in your notes.

**If the log shows an error**, check the "If something goes wrong" table at the end of this guide.

---

## Step 4: Try it (10 min)

1. Open your link. A bar at the top says payments are simulated, and there's a week of sample shows.
2. Click a showtime, pick seats, click **Hold seats**. Choose **Create account** and sign up.
3. An 8-minute timer starts. Click **Pay**. A payment window opens. Click **Pay ₹…**.
4. You land on **My bookings** with a green **Confirmed**.

Test the tricky parts too:

- Open the same show on your phone while you hold seats on the laptop. Your seats show as striped ("Someone is paying") and can't be picked.
- Click **Simulate failure** in the payment window. You get a failure message and your seats stay held so you can retry.
- Let the timer run out. The seats become free again for everyone.

**Add your own shows:** go to your link plus `/admin` (for example `https://cinebook-yourname.onrender.com/admin`), enter your admin password, then add a movie and a show. It appears on the home page immediately.

Share your link with anyone. They can sign up and book.

---

## What's real and what's simulated

**Real:** a public website anyone can open, real accounts, live seat maps, seat holds that can't be double-booked, an admin panel, and a database that keeps everything.

**Simulated:** the payment. No money moves.

**Free plan limits:**

- Render's free server sleeps after 15 minutes with no visitors. The next visitor waits about a minute while it wakes up.
- No "forgot password" yet. That needs an email-sending service.

---

## Optional: switch to Razorpay later

The code already contains a full Razorpay integration. It turns on automatically when Razorpay keys are present. To use it you need a verified Razorpay account (PAN, Aadhaar and bank account; every Indian payment gateway asks for these by law).

1. In Razorpay (**Test Mode**), go to **Account & Settings → API Keys → Generate Key**. Save the Key Id and Key Secret.
2. On Render → your service → **Environment**, add `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET` (any random text of 20+ characters). **Save Changes.** The log should now say `(TEST payments)`.
3. In Razorpay → **Account & Settings → Webhooks → Add New Webhook**: URL = your link + `/api/payments/webhook`, secret = the same `RAZORPAY_WEBHOOK_SECRET`, events **payment.captured**, **payment.authorized**, **order.paid**.
4. Test with UPI ID `success@razorpay`.

To go back to demo mode, delete the two `RAZORPAY_KEY_...` variables on Render and save.

---

## If something goes wrong

| What you see | What to do |
|---|---|
| Render log: `DATABASE_URL is not set` | The key name has a typo or is missing. Go to Render → your service → **Environment**, fix it, **Save Changes**. |
| Payment window says `Razorpay ... Authentication failed` | You still have `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` on Render (maybe placeholder values). Delete both under **Environment** and save to use demo payments. |
| Render log: `password authentication failed` or `getaddrinfo ENOTFOUND` | The Neon string was copied incompletely. Copy it again from Neon and replace `DATABASE_URL`. |
| Render log: `Cannot find module` or `package.json not found` | Files went into a subfolder on GitHub. See the check at the end of step 1. |
| Site takes about a minute to open | Normal on the free plan: it was asleep. |
| Admin says **Wrong admin password** | It must match `ADMIN_PASSWORD` on Render exactly, including capitals. |
| Anything else | Copy the last 20 lines of the Render log (**Logs** tab) and send them to me. |
