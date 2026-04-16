// routes/stripe.js — FIRST-FIN Billing
const { pool } = require('../lib/db');

const { EXEMPT_EMAILS } = require('../lib/constants');

// ── Input validation helpers ──────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const VALID_PLANS = ['monthly', 'annual'];
const VALID_STATUSES = ['active', 'lapsed', 'cancelled', 'past_due', 'pending'];

function validatePublicCheckoutInput({ plan, email, name, dealership }) {
  if (!email || typeof email !== 'string')
    return 'Email is required';
  if (!EMAIL_RE.test(email.trim()))
    return 'Invalid email address';
  if (email.length > 254)
    return 'Email too long';

  if (!name || typeof name !== 'string' || !name.trim())
    return 'Your name is required';
  if (name.length > 120)
    return 'Name too long';

  if (!dealership || typeof dealership !== 'string' || !dealership.trim())
    return 'Dealership name is required';
  if (dealership.length > 160)
    return 'Dealership name too long';

  if (!VALID_PLANS.includes(plan))
    return 'Invalid plan selected';

  return null; // valid
}

// ── Error sanitizer — never leak DB internals to client ──────────
function sanitizeError(e) {
  console.error('Route error:', e);
  return 'An unexpected error occurred. Please try again.';
}

module.exports = function stripeRoutes(app, { requireAuth }) {

  function getStripe() {
    if (!process.env.STRIPE_SECRET_KEY) return null;
    return require('stripe')(process.env.STRIPE_SECRET_KEY);
  }

  // ── POST /api/billing/public-checkout — NO auth, for new buyers ──
  app.post('/api/billing/public-checkout', async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ success: false, error: 'Billing not configured' });

    const { plan, email, name, dealership, phone = '' } = req.body;

    // ── ONBOARDING TEST BYPASS ─────────────────────────────────────────────
    // Set ONBOARDING_TEST_MODE=true in Railway env vars to skip real Stripe payment.
    // Redirects straight to the purchase=success landing page so you can test the
    // full onboarding flow without being charged. Remove or set to false for production.
    if (process.env.ONBOARDING_TEST_MODE === 'true') {
      const baseUrl = process.env.BASE_URL || '';
      console.log(`[TEST MODE] Bypassing Stripe for: ${email} (${name} / ${dealership})`);
      return res.json({ success: true, url: `${baseUrl}/?purchase=success&test=1` });
    }
    // ──────────────────────────────────────────────────────────────────────

    // ── Validate all fields ────────────────────────────────────────
    const validationError = validatePublicCheckoutInput({ plan, email, name, dealership });
    if (validationError)
      return res.status(400).json({ success: false, error: validationError });

    const cleanEmail      = email.trim().toLowerCase();
    const cleanName       = name.trim();
    const cleanDealership = dealership.trim();

    const priceId = plan === 'annual'
      ? process.env.STRIPE_PRICE_ANNUAL
      : process.env.STRIPE_PRICE_MONTHLY;

    if (!priceId) return res.status(503).json({ success: false, error: 'Price not configured' });

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'subscription',
        customer_email: cleanEmail,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${process.env.BASE_URL}/?purchase=success`,
        cancel_url:  `${process.env.BASE_URL}/?purchase=cancelled`,
        metadata: {
          name:        cleanName,
          dealership:  cleanDealership,
          plan:        plan,
          phone:       (req.body.phone || '').toString().trim().substring(0, 20),
          source:      'public_modal'
        },
        subscription_data: {
          metadata: {
            email:      cleanEmail,
            name:       cleanName,
            dealership: cleanDealership,
            phone:      (req.body.phone || '').toString().trim().substring(0, 20)
          }
        }
      });

      res.json({ success: true, url: session.url });
    } catch (e) {
      console.error('Public checkout error:', e.message);
      res.status(500).json({ success: false, error: 'Checkout failed — please try again' });
    }
  });

  // ── POST /api/billing/checkout — Requires auth (existing users) ──
  app.post('/api/billing/checkout', requireAuth, async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ success: false, error: 'Billing not configured' });

    const { plan } = req.body;

    // ── ONBOARDING TEST BYPASS ─────────────────────────────────────────────
    if (process.env.ONBOARDING_TEST_MODE === 'true') {
      const baseUrl = process.env.BASE_URL || '';
      console.log(`[TEST MODE] Bypassing Stripe checkout for user ${req.user.userId}`);
      return res.json({ success: true, url: `${baseUrl}/platform?billing=success&test=1` });
    }
    // ──────────────────────────────────────────────────────────────────────

    if (!VALID_PLANS.includes(plan))
      return res.status(400).json({ success: false, error: 'Invalid plan selected' });

    const priceId = plan === 'annual'
      ? process.env.STRIPE_PRICE_ANNUAL
      : process.env.STRIPE_PRICE_MONTHLY;

    if (!priceId) return res.status(503).json({ success: false, error: 'Price not configured' });

    const client = await pool.connect();
    try {
      const result = await client.query('SELECT * FROM desk_users WHERE id = $1', [req.user.userId]);
      const user = result.rows[0];
      if (!user) return res.status(404).json({ success: false, error: 'User not found' });

      if (EXEMPT_EMAILS.includes(user.email)) {
        return res.json({ success: true, exempt: true });
      }

      let customerId = user.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          name:  user.display_name,
          metadata: { userId: String(user.id) }
        });
        customerId = customer.id;
        await client.query(
          'UPDATE desk_users SET stripe_customer_id = $1 WHERE id = $2',
          [customerId, user.id]
        );
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${process.env.BASE_URL}/platform?billing=success`,
        cancel_url:  `${process.env.BASE_URL}/platform?billing=cancelled`,
        subscription_data: { metadata: { userId: String(user.id) } }
      });

      res.json({ success: true, url: session.url });
    } catch (e) {
      console.error('Checkout error:', e.message);
      res.status(500).json({ success: false, error: 'Checkout failed — please try again' });
    } finally {
      client.release();
    }
  });

  // ── POST /api/billing/topup/create-checkout ──────────────────────
  // One-time Stripe Checkout Session for tenant Twilio overage top-ups.
  // Body: { cents } — integer cents ($5–$500 range). Stripe fires a
  // webhook on success; the checkout.session.completed handler detects
  // metadata.kind === 'topup' and calls addOverage(userId, cents).
  app.post('/api/billing/topup/create-checkout', requireAuth, async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ success: false, error: 'Billing not configured' });

    const cents = parseInt(req.body?.cents, 10);
    if (!Number.isFinite(cents) || cents < 500 || cents > 50000) {
      return res.status(400).json({ success: false, error: 'Top-up must be between $5 and $500' });
    }

    // ── ONBOARDING TEST BYPASS (dev/test only — never enable in prod) ────
    if (process.env.ONBOARDING_TEST_MODE === 'true') {
      const { addOverage } = require('../lib/spend-cap');
      await addOverage(req.user.userId, cents);
      const baseUrl = process.env.BASE_URL || '';
      return res.json({ success: true, url: `${baseUrl}/platform?topup=success&test=1` });
    }

    const client = await pool.connect();
    try {
      const userRes = await client.query(
        'SELECT email, stripe_customer_id FROM desk_users WHERE id = $1',
        [req.user.userId]
      );
      const user = userRes.rows[0];
      if (!user) return res.status(404).json({ success: false, error: 'User not found' });

      const baseUrl = process.env.BASE_URL || '';
      const sessionOpts = {
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [{
          price_data: {
            currency:     'cad',
            unit_amount:  cents,
            product_data: {
              name:        'Twilio overage top-up',
              description: `One-time top-up credited to your spend balance — $${(cents/100).toFixed(2)} CAD`
            }
          },
          quantity: 1
        }],
        success_url: `${baseUrl}/platform?topup=success&amount=${cents}`,
        cancel_url:  `${baseUrl}/platform?topup=cancelled`,
        metadata: {
          kind:    'topup',
          userId:  String(req.user.userId),
          cents:   String(cents),
        }
      };
      if (user.stripe_customer_id) {
        sessionOpts.customer = user.stripe_customer_id;
      } else {
        sessionOpts.customer_email = user.email;
      }

      const session = await stripe.checkout.sessions.create(sessionOpts);
      res.json({ success: true, url: session.url });
    } catch (e) {
      console.error('Top-up checkout error:', e.message);
      res.status(500).json({ success: false, error: 'Top-up session failed — please try again' });
    } finally {
      client.release();
    }
  });

  // ── POST /api/billing/portal ─────────────────────────────────────
  app.post('/api/billing/portal', requireAuth, async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ success: false, error: 'Billing not configured' });

    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT stripe_customer_id FROM desk_users WHERE id = $1',
        [req.user.userId]
      );
      const customerId = result.rows[0]?.stripe_customer_id;
      if (!customerId) return res.status(400).json({ success: false, error: 'No billing account found' });

      const session = await stripe.billingPortal.sessions.create({
        customer:   customerId,
        return_url: `${process.env.BASE_URL}/platform`
      });

      res.json({ success: true, url: session.url });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── GET /api/billing/status ──────────────────────────────────────
  app.get('/api/billing/status', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT email, subscription_status, trial_ends_at, stripe_customer_id FROM desk_users WHERE id = $1',
        [req.user.userId]
      );
      const user = result.rows[0];
      if (!user) return res.status(404).json({ success: false, error: 'User not found' });

      const exempt = EXEMPT_EMAILS.includes(user.email);
      const status = getBillingStatus(user, exempt);
      res.json({ success: true, ...status, exempt });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── POST /api/stripe/webhook — raw body ──────────────────────────
  app.post('/api/stripe/webhook', async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(200).send('OK');

    const sig = req.headers['stripe-signature'];
    if (!sig) {
      console.error('Webhook: missing stripe-signature header');
      return res.status(400).send('Missing signature');
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (e) {
      console.error('Webhook signature failed:', e.message);
      return res.status(400).send('Webhook signature failed');
    }

    const client = await pool.connect();
    try {
      // ── Idempotency — ignore duplicate webhook deliveries ──────
      await client.query(`
        CREATE TABLE IF NOT EXISTS stripe_events (
          event_id TEXT PRIMARY KEY,
          processed_at TIMESTAMPTZ DEFAULT NOW()
        )
      `).catch(() => {});
      const already = await client.query(
        'SELECT event_id FROM stripe_events WHERE event_id = $1', [event.id]
      );
      if (already.rows.length > 0) {
        client.release();
        return res.json({ received: true });
      }
      await client.query(
        'INSERT INTO stripe_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [event.id]
      );

      switch (event.type) {

        case 'checkout.session.completed': {
          const session    = event.data.object;

          // ── Top-up path: credit tenant overage balance and return ──
          if (session.metadata?.kind === 'topup') {
            const topupUserId = parseInt(session.metadata.userId, 10);
            const topupCents  = parseInt(session.metadata.cents, 10);
            if (topupUserId && topupCents > 0) {
              try {
                const { addOverage } = require('../lib/spend-cap');
                await addOverage(topupUserId, topupCents);
                console.log(`💰 Overage top-up: user ${topupUserId} +$${(topupCents/100).toFixed(2)}`);
              } catch (err) {
                console.error('Top-up credit failed:', err.message);
              }
            }
            break;
          }

          const userId     = session.subscription_data?.metadata?.userId;
          const buyerEmail = (session.customer_email || session.metadata?.email || '').toLowerCase().trim();
          const buyerName  = session.metadata?.name        || 'New Customer';
          const dealership = session.metadata?.dealership  || '';
          const plan       = session.metadata?.plan        || 'monthly';
          const source     = session.metadata?.source      || 'authenticated';

          if (userId) {
            // ── Authenticated flow: update existing user ───────────
            await client.query(
              `UPDATE desk_users
               SET subscription_status = 'active', stripe_customer_id = $1
               WHERE id = $2`,
              [session.customer, userId]
            );
            console.log(`✅ Subscription activated — user ${userId}`);

          } else if (buyerEmail) {
            // ── Public flow: check if email already has an account ─
            const existing = await client.query(
              'SELECT id, subscription_status FROM desk_users WHERE email = $1',
              [buyerEmail]
            );

            if (existing.rows.length > 0) {
              // Email exists — activate their account + link Stripe customer
              await client.query(
                `UPDATE desk_users
                 SET subscription_status = 'active', stripe_customer_id = $1
                 WHERE email = $2`,
                [session.customer, buyerEmail]
              );
              console.log(`✅ Existing account activated via public checkout — ${buyerEmail}`);
            } else {
              // Brand new buyer — create pending account + log inquiry
              const buyerPhone = session.metadata?.phone || '';
              const bcrypt = require('bcryptjs');
              const crypto = require('crypto');

              // Generate a temporary random password — dealer must reset
              const tempPass = crypto.randomBytes(8).toString('hex');
              const passHash = await bcrypt.hash(tempPass, 12);

              const initSettings = {
                dealerName: dealership || 'My Dealership',
                salesName: buyerName,
                tempPassword: tempPass,          // shown in admin panel until dealer logs in
                onboardingPending: true,          // triggers first-login wizard
                stripeCustomerId: session.customer,
                plan: plan,
                subscribedAt: new Date().toISOString()
              };

              const newUser = await client.query(
                `INSERT INTO desk_users
                   (email, password_hash, display_name, role, settings_json,
                    subscription_status, stripe_customer_id)
                 VALUES ($1, $2, $3, 'owner', $4, 'active', $5)
                 ON CONFLICT (email) DO UPDATE
                   SET subscription_status = 'active',
                       stripe_customer_id = EXCLUDED.stripe_customer_id,
                       settings_json = desk_users.settings_json || $4::jsonb
                 RETURNING id`,
                [buyerEmail, passHash, buyerName,
                 JSON.stringify(initSettings),
                 session.customer]
              ).catch(e => { console.error('Create user error:', e.message); return { rows: [] }; });

              const newUserId = newUser.rows[0]?.id;

              // Write to platform_inquiries so it shows in admin panel
              await client.query(
                `INSERT INTO platform_inquiries
                   (name, dealership, phone, email, status)
                 VALUES ($1, $2, $3, $4, 'paid')
                 ON CONFLICT DO NOTHING`,
                [buyerName, dealership || '', buyerPhone, buyerEmail]
              ).catch(e => console.error('Inquiry insert error:', e.message));

              console.log('✅ New dealer account created — ' + buyerEmail + ' (user ' + newUserId + ')');

              // ── SMS credentials to buyer if phone provided ─────────
              if (buyerPhone) {
                try {
                  const twilioC = require('twilio')(
                    process.env.TWILIO_ACCOUNT_SID,
                    process.env.TWILIO_AUTH_TOKEN
                  );
                  const platformUrl = process.env.BASE_URL
                    ? process.env.BASE_URL.replace(/\/$/, '') + '/platform'
                    : 'https://app.firstfinancialcanada.com/platform';
                  await twilioC.messages.create({
                    body:
                      `Welcome to FIRST-FIN, ${buyerName.split(' ')[0]}! 🎉\n\n` +
                      `Your account is ready. Log in here:\n${platformUrl}\n\n` +
                      `Email: ${buyerEmail}\n` +
                      `Temp password: ${tempPass}\n\n` +
                      `Change your password in Settings after logging in.\n` +
                      `Questions? Call/text 587-306-6133`,
                    from: process.env.TWILIO_PHONE_NUMBER,
                    to:   buyerPhone
                  });
                  console.log('📱 Credentials SMS sent to buyer: ' + buyerPhone);
                } catch (smsErr) {
                  console.error('Buyer credentials SMS failed:', smsErr.message);
                }
              }
            }
          }

          // ── Notify via SMS for ALL purchases ──────────────────────
          try {
            const twilio = require('twilio')(
              process.env.TWILIO_ACCOUNT_SID,
              process.env.TWILIO_AUTH_TOKEN
            );
            const buyerPhone = session.metadata?.phone || 'not provided';
            await twilio.messages.create({
              body: `💳 NEW FIRST-FIN PURCHASE!\n` +
                    `Name: ${buyerName}\n` +
                    `Dealership: ${dealership}\n` +
                    `Email: ${buyerEmail}\n` +
                    `Phone: ${buyerPhone}\n` +
                    `Plan: ${plan}\n` +
                    (source === 'public_modal' ? `✅ Account auto-created — check admin panel for temp password` : `✅ Existing account activated`) + `\n` +
                    `🔗 ${process.env.BASE_URL}/admin`,
              from: process.env.TWILIO_PHONE_NUMBER,
              to:   process.env.FORWARD_PHONE
            });
          } catch (smsErr) {
            console.error('Admin SMS failed:', smsErr.message);
          }

          console.log(`✅ New purchase: ${buyerEmail} — ${plan}`);
          break;
        }

        case 'customer.subscription.updated': {
          const sub        = event.data.object;
          const userId     = sub.metadata?.userId;
          const customerId = sub.customer;
          const status     = (sub.status === 'active' || sub.status === 'trialing')
            ? 'active'
            : sub.status;

          if (userId) {
            // Authenticated user — update by userId
            await client.query(
              'UPDATE desk_users SET subscription_status = $1 WHERE id = $2',
              [status, userId]
            );
          } else if (customerId) {
            // Public buyer — look up by stripe_customer_id
            await client.query(
              'UPDATE desk_users SET subscription_status = $1 WHERE stripe_customer_id = $2',
              [status, customerId]
            );
          }
          break;
        }

        case 'customer.subscription.deleted': {
          const sub        = event.data.object;
          const userId     = sub.metadata?.userId;
          const customerId = sub.customer;

          if (userId) {
            await client.query(
              `UPDATE desk_users SET subscription_status = 'lapsed' WHERE id = $1`,
              [userId]
            );
            console.log(`⚠️ Subscription lapsed — user ${userId}`);
          } else if (customerId) {
            await client.query(
              `UPDATE desk_users SET subscription_status = 'lapsed' WHERE stripe_customer_id = $1`,
              [customerId]
            );
            console.log(`⚠️ Subscription lapsed — customer ${customerId}`);
          }
          break;
        }

        case 'invoice.payment_failed': {
          // Payment failed but subscription not yet cancelled — set past_due
          // Billing middleware blocks write access for non-active/trial statuses
          const invoice    = event.data.object;
          const customerId = invoice.customer;
          const attempt    = invoice.attempt_count || 1;

          if (customerId) {
            await client.query(
              `UPDATE desk_users SET subscription_status = 'past_due' WHERE stripe_customer_id = $1`,
              [customerId]
            );
            console.log(`⚠️ Payment failed (attempt ${attempt}) — customer ${customerId}`);

            // Notify owner so they can follow up
            try {
              const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
              const userRow = await client.query(
                'SELECT email, display_name FROM desk_users WHERE stripe_customer_id = $1',
                [customerId]
              );
              const name  = userRow.rows[0]?.display_name || 'Unknown';
              const email = userRow.rows[0]?.email || customerId;
              await twilio.messages.create({
                body: `⚠️ FIRST-FIN PAYMENT FAILED
Dealer: ${name}
Email: ${email}
Attempt: ${attempt}
Follow up — they have been set to past_due.`,
                from: process.env.TWILIO_PHONE_NUMBER,
                to:   process.env.FORWARD_PHONE
              });
            } catch(e) { console.error('Payment failed notify error:', e.message); }
          }
          break;
        }

        case 'invoice.payment_succeeded': {
          // Payment recovered — restore active status
          const invoice    = event.data.object;
          const customerId = invoice.customer;
          if (customerId && invoice.billing_reason !== 'subscription_create') {
            await client.query(
              `UPDATE desk_users SET subscription_status = 'active' WHERE stripe_customer_id = $1 AND subscription_status = 'past_due'`,
              [customerId]
            );
            console.log(`✅ Payment recovered — customer ${customerId}`);
          }
          break;
        }
      }

      res.json({ received: true });
    } catch (e) {
      console.error('Webhook handler error:', e.message);
      res.status(500).send('error');
    } finally {
      client.release();
    }
  });

  // NOTE: POST /api/admin/users/:id/subscription is handled in admin-dashboard.js
  // (registered first in index.js). Removed duplicate here to avoid shadowing.

};

// ── Helpers ───────────────────────────────────────────────────────
function getBillingStatus(user, exempt) {
  if (exempt) return { access: 'full', reason: 'exempt' };

  const status   = user.subscription_status;
  const trialEnd = user.trial_ends_at ? new Date(user.trial_ends_at) : null;
  const now      = new Date();

  if (status === 'active')  return { access: 'full',     reason: 'active' };
  if (status === 'lapsed')  return { access: 'readonly', reason: 'lapsed' };

  if (!status || status === 'trial') {
    if (trialEnd && now < trialEnd) {
      const daysLeft = Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24));
      return { access: 'full', reason: 'trial', daysLeft, trialEnd };
    }
    return { access: 'readonly', reason: 'trial_expired' };
  }

  return { access: 'readonly', reason: status };
}

module.exports.getBillingStatus = getBillingStatus;
module.exports.EXEMPT_EMAILS    = EXEMPT_EMAILS;
