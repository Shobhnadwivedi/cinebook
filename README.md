# CineBook

Online movie ticket booking: customers create an account, pick seats on a live seat map, pay through Razorpay (UPI, cards, netbanking, wallets), and get a confirmed booking. The admin panel adds movies, theatres and shows and shows sales.

**Stack:** Node.js + Express, PostgreSQL, Razorpay Checkout, plain HTML/CSS/JS (no build step). Designed to run on Render (web server) and Neon (database), both free.

## Deploy

See **GUIDE.md** for click-by-click steps. Environment variables:

| Variable | What it is |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Neon) |
| `RAZORPAY_KEY_ID` | Razorpay key id (`rzp_test_...` or `rzp_live_...`) |
| `RAZORPAY_KEY_SECRET` | Razorpay key secret |
| `RAZORPAY_WEBHOOK_SECRET` | Secret you set on the Razorpay webhook |
| `ADMIN_PASSWORD` | Password for `/admin`, at least 8 characters |
| `HOLD_MINUTES` | Optional, seat hold length, default 8 |

On first start the app creates its tables and adds sample theatres, movies and a week of shows.

## How booking stays correct

**Seat holds.** `POST /api/holds` runs one transaction that locks the requested seat rows with `SELECT ... FOR UPDATE`, always in sorted order, checks each is free (or its hold has expired), then marks them `HELD` for 8 minutes. Concurrent requests for the same seats wait on the row lock and then see them taken. Sorted lock order prevents deadlocks between overlapping multi-seat requests; deadlock and serialization errors are retried anyway. Holds are all-or-nothing.

**Payments.** The server creates a Razorpay order for the amount stored in the database. The result reaches the server three independent ways: the browser's signed checkout response, Razorpay's signed webhook, and a background reconciler that asks Razorpay about unsettled orders. All three call the same `settle()`, which verifies amount and order with Razorpay, captures if needed, and locks the payment row so the booking is confirmed exactly once.

**Late payments.** If payment completes after the hold expired, the seats are re-taken if still free; otherwise the booking is refunded automatically through Razorpay, and failed refunds are retried.

**Last line of defence.** `confirmed_seats` has primary key `(show_id, seat_label)`, so the database cannot store the same seat as sold twice.

Also: idempotency keys on seat holds (safe across multiple servers), scrypt password hashing, hashed session tokens, constant-time secret comparisons, rate limits on login, admin and holds, strict Content-Security-Policy, integer money (paise), `textContent`-only rendering against XSS, connection pooling, indexes, response compression, ETag revalidation for seat map polling, graceful shutdown, `/api/health`.

## Tests

`tests/run-tests.js` starts a stand-in Razorpay API and two app servers sharing one PostgreSQL database, then checks 29 scenarios including: 50 users racing for one seat across both servers; 20 overlapping multi-seat requests; duplicate requests across servers; browser confirmation plus two webhooks arriving together; forged signatures; underpayment; someone else's payment or booking; hold expiry; late payment with and without the seat still free; closed tab after paying; admin validation.

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/cinebook_test npm test
```

## Not included yet

- Password reset by email (needs an email provider such as Resend or SES)
- Legal pages (terms, privacy, refund policy, contact) that Razorpay requires before approving live payments
- Live seat updates use polling every 3 seconds; WebSockets or Server-Sent Events would reduce load at scale
- Editing or cancelling shows from the admin panel
