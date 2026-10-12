// netlify/functions/stripe-webhook.js
// Listens for Stripe subscription events and updates Supabase membership status.
// Endpoint to register in Stripe dashboard: https://YOUR_SITE/.netlify/functions/stripe-webhook

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
  const sub = data.object;

  try {
    switch (type) {
      // Payment succeeded — activate membership
      case 'invoice.payment_succeeded': {
        const subscription = await stripe.subscriptions.retrieve(sub.subscription);
        const customerId = sub.customer;
        await setMembership(customerId, true);
        break;
      }

      // Subscription created/updated
      case 'customer.subscription.updated': {
        const active = ['active', 'trialing'].includes(sub.status);
        await setMembership(sub.customer, active);
        break;
      }

      // Subscription cancelled or payment failed
      case 'customer.subscription.deleted':
      case 'invoice.payment_failed': {
        const customerId = sub.customer ?? sub.subscription;
        await setMembership(customerId, false);
        break;
      }

      default:
        // Ignore other events
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
 * Also stores the stripe_customer_id if not already set.
 */
async function setMembership(stripeCustomerId, isMember) {
  if (!stripeCustomerId) return;

  // Try to find user in profiles by stripe_customer_id
  const { data: profile } = await sb
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', stripeCustomerId)
    .single();

  if (profile) {
    await sb.from('profiles').update({ is_member: isMember }).eq('id', profile.id);
    return;
  }

  // Fallback: look up email from Stripe and match to Supabase auth user
   // Fallback: look up email from Stripe and match to Supabase auth user
  try {
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    if (customer.email) {
      // Find Supabase user by email via direct query
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
  }
}
