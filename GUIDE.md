# Put CineBook online: step by step

Everything below happens in your web browser. You don't need to install anything or type any code.

You will sign up for 4 free websites. Each one does one job:

| Website | Its job | Think of it as |
|---|---|---|
| **GitHub** | Stores your code | A Google Drive for code |
| **Neon** | Stores your data (users, bookings, seats) | The app's notebook that never forgets |
| **Razorpay** | Takes payments | The cash counter |
| **Render** | Runs your app 24/7 and gives it a public link | The shop building |

Time: about 60 minutes. Keep a notes app open. You'll collect **6 values** along the way and paste them into Render at the end:

```
DATABASE_URL            = (from Neon, step 2)
RAZORPAY_KEY_ID         = (from Razorpay, step 3)
RAZORPAY_KEY_SECRET     = (from Razorpay, step 3)
RAZORPAY_WEBHOOK_SECRET = (you make it up, step 3)
ADMIN_PASSWORD          = (you make it up, step 3)
Your website link       = (from Render, step 4)
```

Treat the Neon link, the Razorpay secret and the admin password like bank passwords. Never share them or put them in a screenshot.

---

## Step 1: Put the code on GitHub (10 min)

1. Unzip `cinebook-live.zip` (double-click it). You get a folder called `cinebook-live`.
2. Go to https://github.com and sign in.
3. Click the **+** at the top right, then **New repository**.
4. Repository name: `cinebook`. Choose **Public**. Leave everything else as it is. Click **Create repository**.
5. On the next page, click the link **uploading an existing file**.
6. Open the `cinebook-live` folder in Finder. Press `Cmd + A` to select everything inside it (`public`, `src`, `tests`, `package.json`, `package-lock.json`, `README.md`, `GUIDE.md`). Drag all of it into the GitHub page.
7. Wait until every file is listed. Scroll down and click **Commit changes**.

**Check:** your repository page shows the folders `public`, `src`, `tests` and the file `package.json` at the top level. If you see a single `cinebook-live` folder instead, you dragged the folder itself rather than its contents. Delete the repository (Settings, bottom of the page) and repeat from step 3.

---

## Step 2: Create the database on Neon (5 min)

1. Go to https://neon.tech and click **Sign up**. Choose **Continue with GitHub**.
2. Create a project. Name: `cinebook`. Region: pick **Asia Pacific (Singapore)**, the closest to India. Click **Create**.
3. You'll see a **Connection string** box. Make sure the **Pooled connection** option is turned on if you see it. Click **Copy**.

It looks like `postgresql://neondb_owner:abc123@ep-something-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`.

Paste it in your notes as **DATABASE_URL**. You don't need to create any tables; the app does that itself on first start.

---

## Step 3: Get Razorpay test keys (10 min)

1. Go to https://razorpay.com and click **Sign Up**. Use your email and phone number and verify the OTPs.
2. It will ask for business details (KYC). **Skip it for now.** You don't need it for test mode.
3. In the dashboard, make sure the switch at the top says **Test Mode**.
4. Go to **Account & Settings**, then **API Keys**, then **Generate Key**.
5. A box shows **Key Id** (starts with `rzp_test_`) and **Key Secret**. Click **Download Key Details** and also paste both into your notes as **RAZORPAY_KEY_ID** and **RAZORPAY_KEY_SECRET**. Razorpay never shows the secret again.

Now invent two passwords and write them in your notes:

- **RAZORPAY_WEBHOOK_SECRET**: any random text of 20+ characters, for example `mango-river-7731-cinema-quiet`. You'll give it to Razorpay in step 5.
- **ADMIN_PASSWORD**: at least 8 characters. This opens your admin panel.

---

## Step 4: Put the app online with Render (15 min)

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

6. Scroll to **Environment Variables**. Click **Add Environment Variable** five times and fill in, copying exactly from your notes:

| Key | Value |
|---|---|
| `DATABASE_URL` | your Neon connection string |
| `RAZORPAY_KEY_ID` | `rzp_test_...` |
| `RAZORPAY_KEY_SECRET` | your key secret |
| `RAZORPAY_WEBHOOK_SECRET` | the random text you invented |
| `ADMIN_PASSWORD` | your admin password |

7. Click **Deploy Web Service**.

You'll see a log scrolling. After 2 to 4 minutes, look for these lines:

```
Empty database: added sample theatres, movies and shows.
CineBook running on port 10000 (TEST payments)
```

and a green **Live** badge. Your link is at the top, like `https://cinebook-yourname.onrender.com`. Save it in your notes.

**If the log shows an error**, check the "If something goes wrong" table at the end of this guide.

---

## Step 5: Connect Razorpay's webhook (5 min)

This lets Razorpay tell your app "this person paid" directly, even if the customer closes their browser the moment they pay.

1. In Razorpay (still in **Test Mode**), go to **Account & Settings**, then **Webhooks**, then **Add New Webhook**.
2. Webhook URL: your link plus `/api/payments/webhook`, for example `https://cinebook-yourname.onrender.com/api/payments/webhook`
3. Secret: your **RAZORPAY_WEBHOOK_SECRET** (the exact same text as on Render).
4. Active events: tick **payment.captured**, **payment.authorized** and **order.paid**.
5. Click **Create Webhook**.

---

## Step 6: Try it (10 min)

1. Open your link. You'll see a yellow bar saying test mode is on, and a week of sample shows.
2. Click a showtime, pick seats, click **Hold seats**. Choose **Create account** and sign up.
3. An 8-minute timer starts. Click **Pay**. The real Razorpay payment window opens.
4. Choose **UPI** and enter `success@razorpay`. Or choose **Card**, use a test card from https://razorpay.com/docs/payments/payments/test-card-upi-details/, any future expiry and any CVV, then click **Success** on the mock bank page.
5. You land on **My bookings** with a green **Confirmed**.
6. Check Razorpay: **Transactions → Payments** shows the payment as **captured**.

Test the tricky parts too:

- Open the same show on your phone while you hold seats on the laptop. The seats show as striped ("Someone is paying") and can't be picked.
- Pay with UPI `failure@razorpay`. You get a failure message and your seats stay held so you can retry.

**Add your own shows:** go to your link plus `/admin` (for example `https://cinebook-yourname.onrender.com/admin`), enter your admin password, then add a movie and a show. It appears on the home page immediately.

Share your link with anyone. They can sign up and book.

---

## What "real" means right now, and what's left

**Working now:** a public website anyone can open, real accounts, a real Razorpay integration (the same code path that handles real money), automatic refunds, and an admin panel.

**Test mode means no money moves.** To accept real payments:

1. In Razorpay, complete KYC (PAN, bank account, business details) and submit your website. Razorpay reviews websites for pages like terms, privacy, refund policy and contact details, so ask me to add those pages first.
2. After approval, switch to **Live Mode**, generate live keys, and replace `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` on Render (**Environment** tab, then **Save Changes**; Render restarts automatically). Create the webhook again in Live Mode with the same URL and secret.

Selling tickets for real screenings also needs an agreement with the cinemas. That's business, not code.

**Free plan limits to know:**

- Render's free server sleeps after 15 minutes with no visitors. The next visitor waits about a minute while it wakes up. Upgrading to Render's paid Starter plan removes this.
- No "forgot password" yet. That needs an email-sending service; ask me when you want it.

---

## If something goes wrong

| What you see | What to do |
|---|---|
| Render log: `DATABASE_URL is not set` | The key name has a typo or is missing. Go to Render → your service → **Environment**, fix it, **Save Changes**. |
| Render log: `RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set` | Same as above, for the Razorpay keys. |
| Render log: `password authentication failed` or `getaddrinfo ENOTFOUND` | The Neon string was copied incompletely. Copy it again from Neon and replace `DATABASE_URL`. |
| Render log: `Cannot find module` or `package.json not found` | Files went into a subfolder on GitHub. See the check at the end of step 1. |
| Site takes about a minute to open | Normal on the free plan: it was asleep. |
| Clicking **Pay** gives `Razorpay ... Authentication failed` | Key id and secret don't match, or one is a live key. Regenerate test keys and update both on Render. |
| Admin says **Wrong admin password** | It must match `ADMIN_PASSWORD` on Render exactly, including capitals. |
| Anything else | Copy the last 20 lines of the Render log (**Logs** tab) and send them to me. |
