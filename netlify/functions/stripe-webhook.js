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
        await setMembership(sb, {
          customerId: obj.customer,
          userId: obj.client_reference_id || null,
          email: obj.customer_details?.email || obj.customer_email || null,
          isMember: true,
        });
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

  const update = { is_member: isMember };
  if (customerId) update.stripe_customer_id = customerId;

  const { error } = await sb.from('profiles').update(update).eq('id', profileId);
  if (error) throw new Error(`Supabase update failed: ${error.message}`);
  console.log(`Set is_member=${isMember} for profile ${profileId} (customer ${customerId || 'none'})`);
}
