// netlify/functions/stripe-webhook.js
// Listens for Stripe subscription events and updates Supabase membership status.
// Endpoint registered in Stripe: https://rhiannonsway.com/.netlify/functions/stripe-webhook
// Secrets (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
// live ONLY in Netlify environment variables.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Verify Stripe webhook signature
  const sig = event.headers['stripe-signature'];
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const { type, data } = stripeEvent;
  const obj = data.object;

  try {
    switch (type) {
      // Checkout completed: carries client_reference_id (the Supabase user ID)
      case 'checkout.session.completed': {
        const email = obj.customer_details?.email || obj.customer_email || null;
        const profileId = await setMembership(sb, {
          customerId: obj.customer,
          userId: obj.client_reference_id || null,
          email,
          isMember: true,
        });
        // Welcome email: a failure here is logged but never blocks membership
        try {
          await sendWelcomeEmail(sb, profileId, email, obj.customer_details?.name);
        } catch (err) {
          console.error('Welcome email failed:', err.message);
        }
        break;
      }

      // Payment succeeded: activate / keep active
      case 'invoice.payment_succeeded': {
        await setMembership(sb, {
          customerId: obj.customer,
          email: obj.customer_email || null,
          isMember: true,
        });
        break;
      }

      // Subscription created or changed
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const active = ['active', 'trialing'].includes(obj.status);
        await setMembership(sb, { customerId: obj.customer, isMember: active });
        break;
      }

      // Subscription cancelled
      case 'customer.subscription.deleted': {
        await setMembership(sb, { customerId: obj.customer, isMember: false });
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error(`Error handling ${type}:`, err.message);
    return { statusCode: 500, body: 'Internal error' };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

/**
 * Finds the member's Supabase profile and sets is_member.
 * Match order: Supabase user ID (client_reference_id) -> stripe_customer_id -> email.
 * Always stores the stripe_customer_id so later events (renewals, cancellations) match.
 */
async function setMembership(sb, { customerId, userId = null, email = null, isMember }) {
  let profileId = userId;

  // 1. Match on stored Stripe customer ID
  if (!profileId && customerId) {
    const { data } = await sb.from('profiles').select('id').eq('stripe_customer_id', customerId).maybeSingle();
    if (data) profileId = data.id;
  }

  // 2. Match on email (from the event, or looked up from Stripe)
  if (!profileId) {
    let lookupEmail = email;
    if (!lookupEmail && customerId) {
      try {
        const customer = await stripe.customers.retrieve(customerId);
        lookupEmail = customer?.email || null;
      } catch (err) {
        console.error('Could not retrieve Stripe customer:', err.message);
      }
    }
    if (lookupEmail) {
      const { data } = await sb.from('profiles').select('id').ilike('email', lookupEmail.trim()).maybeSingle();
      if (data) profileId = data.id;
    }
  }

  if (!profileId) {
    console.error(`No Supabase profile found for customer ${customerId} / ${email}`);
    return;
  }

  // Before removing access, make sure this person has no OTHER active subscription
  // (e.g. a duplicate signup under a second Stripe customer was cancelled).
  if (!isMember && (await hasAnyActiveSubscription(customerId))) {
    console.log(`Kept profile ${profileId} active: another active subscription exists`);
    return profileId;
  }

  const update = { is_member: isMember };
  // Only store the customer ID when activating, so a cancelled duplicate never overwrites the live one
  if (customerId && isMember) update.stripe_customer_id = customerId;

  const { data: updated, error } = await sb.from('profiles').update(update).eq('id', profileId).select('id');
  if (error) throw new Error(`Supabase update failed: ${error.message}`);
  if (!updated || updated.length === 0) {
    // Row exists but nothing changed: almost always means the key is not the service role key
    throw new Error('Supabase update matched 0 rows - check SUPABASE_SERVICE_ROLE_KEY in Netlify');
  }
  console.log(`Set is_member=${isMember} for profile ${profileId} (customer ${customerId || 'none'})`);
  return profileId;
}

// ── Welcome email ────────────────────────────────────────────────────────────
// Sent once per member via Resend (RESEND_API_KEY lives only in Netlify env vars).
const WELCOME_FROM = 'RW Move <move@rhiannonsway.com>';
const WELCOME_REPLY_TO = 'move@rhiannonsway.com';
const WELCOME_PDF_URL = 'https://rhiannonsway.com/on-demand/RW-Move-On-Demand-Welcome.pdf';

async function sendWelcomeEmail(sb, profileId, email, fullName) {
  if (!profileId || !email) return;
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set; skipping welcome email');
    return;
  }

  // Atomically claim the send so a member can only ever get one welcome email,
  // even if Stripe delivers the same event twice.
  const { data: claimed, error } = await sb
    .from('profiles')
    .update({ welcome_email_sent_at: new Date().toISOString() })
    .eq('id', profileId)
    .is('welcome_email_sent_at', null)
    .select('id');
  if (error) throw new Error(`Could not claim welcome email: ${error.message}`);
  if (!claimed || claimed.length === 0) return; // already sent

  const firstName = (fullName || '').trim().split(/\s+/)[0] || '';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `welcome-${profileId}`,
    },
    body: JSON.stringify({
      from: WELCOME_FROM,
      to: [email],
      reply_to: WELCOME_REPLY_TO,
      subject: 'Welcome to RW Move On Demand',
      html: welcomeHtml(firstName),
      text: welcomeText(firstName),
      attachments: [{ filename: 'RW-Move-On-Demand-Welcome.pdf', path: WELCOME_PDF_URL }],
    }),
  });

  if (!res.ok) {
    // Release the claim so a Stripe retry can try again
    await sb.from('profiles').update({ welcome_email_sent_at: null }).eq('id', profileId);
    throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
  console.log(`Welcome email sent to profile ${profileId}`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function welcomeText(firstName) {
  return [
    `Hi ${firstName || 'there'},`,
    '',
    "Welcome in! You're officially part of the RW Move community and I'm so happy you're here.",
    '',
    "I've attached your welcome guide with everything you need to get moving. The short version:",
    '',
    '1. Log in at rhiannonsway.com/on-demand/login with the email and password you joined with',
    '2. Open your class library and filter by Dance, Step, Box2theBeat or Workout',
    '3. Press play',
    '',
    "2 to 3 new classes land every month, so there's always something fresh to try.",
    '',
    "Got a question or stuck on anything? Just reply to this email, I read every message. And if you try a class, tag @rhiannons_way so I can see you moving!",
    '',
    'Rhi x',
    '',
    'RW Move On Demand | rhiannonsway.com/on-demand',
  ].join('\n');
}

function welcomeHtml(firstName) {
  const name = escapeHtml(firstName || 'there');
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#faf8f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f4;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:#2e2820;">
  <tr><td style="background:#3f5e4f;padding:32px 32px 28px;">
    <p style="margin:0 0 12px;font-size:11px;letter-spacing:3px;color:#cfdccf;">RW MOVE ON DEMAND</p>
    <h1 style="margin:0;font-size:32px;line-height:1.1;color:#ffffff;">Welcome in.</h1>
    <p style="margin:8px 0 0;font-size:18px;color:#e6efe6;">Move more. <em style="font-family:Georgia,serif;">Your way.</em></p>
  </td></tr>
  <tr><td style="padding:28px 32px 8px;font-size:15px;line-height:1.6;">
    <p style="margin:0 0 16px;">Hi ${name},</p>
    <p style="margin:0 0 16px;">Welcome in! You're officially part of the RW Move community and I'm so happy you're here.</p>
    <p style="margin:0 0 16px;">I've attached your welcome guide with everything you need to get moving. The short version:</p>
    <ol style="margin:0 0 16px;padding-left:20px;">
      <li style="margin-bottom:6px;"><strong>Log in</strong> with the email and password you joined with</li>
      <li style="margin-bottom:6px;"><strong>Open your class library</strong> and filter by Dance, Step, Box2theBeat or Workout</li>
      <li><strong>Press play</strong></li>
    </ol>
    <p style="margin:0 0 24px;">2 to 3 new classes land every month, so there's always something fresh to try.</p>
    <p style="margin:0 0 28px;"><a href="https://rhiannonsway.com/on-demand/login/" style="display:inline-block;background:#c7756d;color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:30px;font-size:14px;">Open the class library</a></p>
    <p style="margin:0 0 16px;">Got a question or stuck on anything? Just reply to this email, I read every message. And if you try a class, tag <a href="https://instagram.com/rhiannons_way" style="color:#c7756d;">@rhiannons_way</a> so I can see you moving!</p>
    <p style="margin:0 0 28px;font-family:Georgia,serif;font-style:italic;font-size:20px;color:#3f5e4f;">Rhi x</p>
  </td></tr>
  <tr><td style="padding:16px 32px;border-top:1px solid #eee6dc;font-size:12px;color:#6b6259;">
    RW Move On Demand | <a href="https://rhiannonsway.com/on-demand/" style="color:#6b6259;">rhiannonsway.com/on-demand</a> | @rhiannons_way
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/**
 * True if any Stripe customer sharing this customer's email has an active or trialing subscription.
 */
async function hasAnyActiveSubscription(customerId) {
  if (!customerId) return false;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    const ids = new Set([customerId]);
    if (customer?.email) {
      const list = await stripe.customers.list({ email: customer.email, limit: 20 });
      list.data.forEach((c) => ids.add(c.id));
    }
    for (const id of ids) {
      const subs = await stripe.subscriptions.list({ customer: id, status: 'all', limit: 20 });
      if (subs.data.some((s) => ['active', 'trialing', 'past_due'].includes(s.status))) return true;
    }
  } catch (err) {
    console.error('Active subscription check failed:', err.message);
  }
  return false;
}
