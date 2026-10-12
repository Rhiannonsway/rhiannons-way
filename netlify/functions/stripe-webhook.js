// netlify/functions/stripe-webhook.js
// Listens for Stripe subscription events and updates Supabase membership status.
// Endpoint to register in Stripe dashboard: https://YOUR_SITE/.netlify/functions/stripe-webhook

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Verify Stripe webhook signature
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const { type, data } = stripeEvent;
  const obj = data.object;

  // Fresh admin client for each invocation
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  try {
    switch (type) {
      // Payment succeeded - activate membership
      case 'invoice.payment_succeeded': {
        await setMembership(sb, obj.customer, true);
        break;
      }

      // Subscription created/updated
      case 'customer.subscription.updated': {
        const active = ['active', 'trialing'].includes(obj.status);
        await setMembership(sb, obj.customer, active);
        break;
      }

      // Subscription cancelled or payment failed
      case 'customer.subscription.deleted':
      case 'invoice.payment_failed': {
        await setMembership(sb, obj.customer, false);
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
 * Looks up the Supabase user by stripe_customer_id and sets is_member.
 * Falls back to email lookup if no profile found by stripe_customer_id.
 */
async function setMembership(sb, stripeCustomerId, isMember) {
  if (!stripeCustomerId) return;

  // Try to find user in profiles by stripe_customer_id
  const { data: profile } = await sb
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle();

  if (profile) {
    await sb.from('profiles').update({ is_member: isMember }).eq('id', profile.id);
    return;
  }

  // Fallback: look up email from Stripe and match to Supabase auth user
  try {
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    if (customer.email) {
      const { data: authUser } = await sb.auth.admin.getUserByEmail(customer.email);
      if (authUser?.user) {
        await sb.from('profiles').upsert({
          id: authUser.user.id,
          stripe_customer_id: stripeCustomerId,
          is_member: isMember,
        });
      }
    }
  } catch (err) {
    console.error('Could not resolve Stripe customer to Supabase user:', err.message);
    throw err;
  }
}
