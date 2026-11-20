import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const origin = (process.env.APP_URL || '').replace(/\/$/, '');
const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const merchantName = (process.env.MERCHANT_NAME || 'Business owner').slice(0, 120);
const required = ['APP_URL','ADMIN_EMAIL','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_ANON_KEY'];
for (const k of required) if (!process.env[k]) console.warn(`Missing required environment variable ${k}`);
if (!origin || !/^https:\/\//.test(origin) && process.env.NODE_ENV === 'production') throw new Error('Production APP_URL must use HTTPS');
const db = createClient(process.env.SUPABASE_URL || 'https://placeholder.supabase.co', process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder', { auth: { persistSession: false, autoRefreshToken: false } });
const authClient = createClient(process.env.SUPABASE_URL || 'https://placeholder.supabase.co', process.env.SUPABASE_ANON_KEY || 'placeholder', { auth: { persistSession: false, autoRefreshToken: false } });
const stripe = (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET) ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"], upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null } } }));

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[a-f0-9]+$/i.test(a) || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}
function webhookError(res, err) { console.error('webhook error:', err); return res.status(500).json({error:'Unable to process notification'}); }
async function findRequest(id) {
  const { data, error } = await db.from('payment_requests').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}
async function setPaid(id, method, expectedReference) {
  // Conditional update ensures a second payment notification does not re-credit a paid order.
  const { data, error } = await db.from('payment_requests').update({status:'paid', verified_at:new Date().toISOString()})
    .eq('id', id).eq('method', method).eq('provider_reference', expectedReference).neq('status','paid').select('id').maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
function validateMoney(amount) {
  const value = String(amount);
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fractional=''] = value.split('.');
  const cents = Number(whole)*100 + Number(fractional.padEnd(2,'0'));
  return cents >= 100 && cents <= 100000000 ? cents : null;
}
function publicRequest(r) { return {id:r.id, description:r.description, amount_cents:r.amount_cents, currency:r.currency, status:r.status, method:r.method, checkout_url:r.checkout_url, created_at:r.created_at}; }

// Important: raw webhook handlers must precede express.json().
app.post('/api/webhooks/paystack', express.raw({type:'application/json',limit:'100kb'}), async(req,res) => {
  try {
    if (!process.env.PAYSTACK_SECRET_KEY) return res.sendStatus(503);
    const signature = crypto.createHmac('sha512',process.env.PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
    if (!safeEqual(signature,req.get('x-paystack-signature'))) return res.sendStatus(401);
    const event = JSON.parse(req.body.toString());
    if (event.event !== 'charge.success') return res.sendStatus(200);
    const ref = String(event.data?.reference || '');
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(ref)) return res.sendStatus(400);
    const {data:r,error} = await db.from('payment_requests').select('*').eq('provider_reference',ref).eq('method','card').maybeSingle();
    if (error) throw error;
    if (!r) return res.sendStatus(200);
    // Fetch payment directly from Paystack to confirm provider status/amount/currency.
    const verify = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, {headers:{Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`}});
    if (!verify.ok) throw new Error(`Paystack verify ${verify.status}`);
    const payload = await verify.json();
    const t = payload?.data;
    if (payload.status === true && t?.status === 'success' && t?.reference === ref && Number(t?.amount) === r.amount_cents && String(t?.currency).toUpperCase() === 'USD') await setPaid(r.id,'card',ref);
    return res.sendStatus(200);
  } catch(err) { return webhookError(res,err); }
});

app.post('/api/webhooks/nowpayments',express.raw({type:'application/json',limit:'100kb'}),async(req,res) => {
  try {
    if (!process.env.NOWPAYMENTS_IPN_SECRET) return res.sendStatus(503);
    const payload = JSON.parse(req.body.toString());
    const signature = crypto.createHmac('sha512',process.env.NOWPAYMENTS_IPN_SECRET).update(JSON.stringify(canonical(payload))).digest('hex');
    if (!safeEqual(signature,req.get('x-nowpayments-sig'))) return res.sendStatus(401);
    if (payload.payment_status !== 'finished') return res.sendStatus(200);
    const ref = String(payload.invoice_id || '');
    if (!ref) return res.sendStatus(200);
    const {data:r,error} = await db.from('payment_requests').select('*').eq('provider_reference',ref).eq('method','crypto').maybeSingle();
    if (error) throw error;
    if (!r) return res.sendStatus(200);
    if (payload.order_id && String(payload.order_id) !== r.id) return res.sendStatus(400);
    if (payload.price_currency && String(payload.price_currency).toUpperCase() !== 'USD') return res.sendStatus(400);
    if (payload.price_amount !== undefined && Math.abs(Number(payload.price_amount)*100-r.amount_cents)>1) return res.sendStatus(400);
    // NOWPayments provider reports invoice complete. Validate IPN format in live sandbox before accepting production funds.
    await setPaid(r.id,'crypto',ref);
    return res.sendStatus(200);
  } catch(err) { return webhookError(res,err); }
});

app.post('/api/webhooks/stripe',express.raw({type:'application/json',limit:'100kb'}),async(req,res) => {
  try {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(503);
    let event;
    try { event = stripe.webhooks.constructEvent(req.body,req.get('stripe-signature'),process.env.STRIPE_WEBHOOK_SECRET); }
    catch { return res.sendStatus(401); }
    if (!['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)) return res.sendStatus(200);
    const session = event.data.object;
    if (session.payment_status !== 'paid') return res.sendStatus(200);
    const id = session.metadata?.request_id;
    if (!id) return res.sendStatus(200);
    const r = await findRequest(id);
    if (r && r.method === 'bank' && r.provider_reference === session.id && session.amount_total === r.amount_cents && session.currency === 'usd') await setPaid(r.id,'bank',session.id);
    return res.sendStatus(200);
  } catch(err) { return webhookError(res,err); }
});

app.use(express.json({limit:'30kb'}));
app.use('/api',rateLimit({windowMs:60_000, limit:70, standardHeaders:'draft-7', legacyHeaders:false}));
function readCookie(req,name) {
  const item = (req.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));
  return item ? decodeURIComponent(item.slice(name.length+1)) : '';
}
function setSession(res,token,maxAge) {
  res.cookie('tp_admin', token, {httpOnly:true,secure:process.env.NODE_ENV === 'production',sameSite:'strict',maxAge,path:'/'});
}
async function requireAdmin(req,res,next) {
  try {
    const token = readCookie(req,'tp_admin');
    if (!token) return res.status(401).json({error:'Sign in required'});
    const {data:{user},error} = await authClient.auth.getUser(token);
    if (error || !user || user.email?.toLowerCase()!==adminEmail) return res.status(403).json({error:'Admin access only'});
    return next();
  } catch(e) { next(e); }
}
// Same-site cookies plus an origin check for state-changing admin requests.
function protectOrigin(req,res,next) {
  const requestOrigin = req.get('origin');
  if (requestOrigin && requestOrigin !== origin) return res.status(403).json({error:'Cross-origin request rejected'});
  next();
}
app.get('/api/health',(_req,res)=>res.json({ok:true,service:'TriPay'}));
app.post('/api/admin/login',rateLimit({windowMs:60_000,limit:8}),protectOrigin,async(req,res,next)=>{
  try {
    const {email,password} = req.body || {};
    if (String(email||'').toLowerCase().trim()!==adminEmail || typeof password!=='string') return res.status(401).json({error:'Invalid credentials'});
    const {data,error} = await authClient.auth.signInWithPassword({email,password});
    if (error || !data.session) return res.status(401).json({error:'Invalid credentials'});
    setSession(res,data.session.access_token,Math.min(data.session.expires_in*1000,3600000));
    return res.json({ok:true,email});
  } catch(e) { next(e); }
});
app.post('/api/admin/logout',protectOrigin,(req,res)=>{res.clearCookie('tp_admin',{path:'/'});res.json({ok:true});});
app.get('/api/admin/me',requireAdmin,(_req,res)=>res.json({ok:true,email:adminEmail}));
app.get('/api/admin/requests',requireAdmin,async(_req,res,next)=>{
  try { const {data,error}=await db.from('payment_requests').select('*').order('created_at',{ascending:false}).limit(100);if(error)throw error;res.json({items:data}); }
  catch(e){next(e);}
});
app.post('/api/admin/requests',protectOrigin,requireAdmin,async(req,res,next)=>{
  try {
    const {email,name='',description,amount} = req.body || {};
    const cents = validateMoney(amount);
    if (!cents || typeof email!=='string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>254 || typeof description!=='string' || !description.trim() || description.length>280 || typeof name!=='string' || name.length>120) return res.status(400).json({error:'Provide a valid email, amount ($1-$1,000,000) and description'});
    const {data,error}=await db.from('payment_requests').insert({customer_email:email.trim(),customer_name:name.trim(),description:description.trim(),amount_cents:cents}).select('*').single();
    if(error)throw error;
    return res.status(201).json({request:data,link:`${origin}/pay/${data.id}`});
  } catch(e){next(e);}
});
app.post('/api/admin/requests/:id/confirm-bank',protectOrigin,requireAdmin,async(req,res,next)=>{
  try {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.sendStatus(400);
    const reference = String(req.body?.bank_reference||'').trim();
    if (reference.length<5 || reference.length>120) return res.status(400).json({error:'Enter a verified bank statement reference (5-120 chars)'});
    const r = await findRequest(req.params.id);
    if (!r || r.method!=='bank' || r.status!=='awaiting_bank_transfer' || r.provider_reference) return res.status(409).json({error:'Not an outstanding manual bank transfer'});
    // Requires admin to independently verify real funds cleared before calling.
    const {data,error}=await db.from('payment_requests').update({status:'paid',bank_reference:reference,verified_at:new Date().toISOString()}).eq('id',r.id).eq('status','awaiting_bank_transfer').is('provider_reference',null).select('id').maybeSingle();
    if(error)throw error;
    if(!data) return res.status(409).json({error:'Request already updated'});
    return res.json({ok:true});
  } catch(e){next(e);}
});

app.get('/api/requests/:id',async(req,res,next)=>{
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({error:'Not found'});
    const r = await findRequest(req.params.id);
    if(!r) return res.status(404).json({error:'Not found'});
    const bankDetails = r.method==='bank' && !r.provider_reference ? {
      account_name:process.env.BANK_ACCOUNT_NAME,
      bank_name:process.env.BANK_NAME,
      account_number:process.env.BANK_ACCOUNT_NUMBER,
      swift:process.env.BANK_SWIFT,
      routing:process.env.BANK_ROUTING,
      branch:process.env.BANK_BRANCH,
      notes:process.env.BANK_NOTES,
      payment_reference:`TP-${r.id.slice(0,8).toUpperCase()}`
    } : null;
    res.json({request:publicRequest(r),merchant_name:merchantName,bank_details:bankDetails,available:{card:!!process.env.PAYSTACK_SECRET_KEY,crypto:!!(process.env.NOWPAYMENTS_API_KEY&&process.env.NOWPAYMENTS_IPN_SECRET),bank:!!stripe || !!(process.env.BANK_ACCOUNT_NAME&&process.env.BANK_NAME&&process.env.BANK_ACCOUNT_NUMBER)}});
  } catch(e){next(e);}
});
app.post('/api/requests/:id/checkout',rateLimit({windowMs:60_000,limit:6}),async(req,res,next)=>{
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({error:'Not found'});
    const method = req.body?.method;
    if(!['card','crypto','bank'].includes(method))return res.status(400).json({error:'Invalid method'});
    const r = await findRequest(req.params.id);
    if(!r)return res.sendStatus(404);
    if(r.status==='paid')return res.status(409).json({error:'Already paid'});
    if(r.method){
      if(r.method===method)return res.json({url:r.checkout_url||null,manual_bank:r.method==='bank'&&!r.provider_reference});
      return res.status(409).json({error:'Payment already started with another method. Contact merchant to change it.'});
    }
    const success = `${origin}/pay/${r.id}`;
    let patch = {method, status:'awaiting_payment'};
    if(method==='card'){
      if(!process.env.PAYSTACK_SECRET_KEY)return res.status(503).json({error:'Card payments not configured'});
      const reference=`TP_${r.id.replaceAll('-','')}`;
      const response=await fetch('https://api.paystack.co/transaction/initialize',{method:'POST',headers:{Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({email:r.customer_email,amount:r.amount_cents,currency:'USD',reference,callback_url:success,metadata:{request_id:r.id,description:r.description}})});
      const pay=await response.json();
      if(!response.ok||!pay.status||!pay.data?.authorization_url)return res.status(502).json({error:'Card checkout unavailable. Confirm USD merchant approval.'});
      patch={...patch,checkout_url:pay.data.authorization_url,provider_reference:reference};
    } else if(method==='crypto'){
      if(!process.env.NOWPAYMENTS_API_KEY||!process.env.NOWPAYMENTS_IPN_SECRET)return res.status(503).json({error:'Crypto payments not configured'});
      const response=await fetch('https://api.nowpayments.io/v1/invoice',{method:'POST',headers:{'x-api-key':process.env.NOWPAYMENTS_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({price_amount:(r.amount_cents/100).toFixed(2),price_currency:'usd',order_id:r.id,order_description:r.description,ipn_callback_url:`${origin}/api/webhooks/nowpayments`,success_url:success,cancel_url:success})});
      const pay=await response.json();
      if(!response.ok||!pay.invoice_url||!pay.id)return res.status(502).json({error:'Crypto checkout unavailable. Confirm merchant configuration.'});
      patch={...patch,checkout_url:pay.invoice_url,provider_reference:String(pay.id)};
    } else if(stripe){
      const session=await stripe.checkout.sessions.create({mode:'payment',payment_method_types:['us_bank_account'],customer_email:r.customer_email,line_items:[{price_data:{currency:'usd',unit_amount:r.amount_cents,product_data:{name:r.description}},quantity:1}],success_url:success,cancel_url:success,metadata:{request_id:r.id}});
      patch={...patch,checkout_url:session.url,provider_reference:session.id};
    } else {
      if(!process.env.BANK_ACCOUNT_NAME||!process.env.BANK_NAME||!process.env.BANK_ACCOUNT_NUMBER)return res.status(503).json({error:'Bank transfer not configured'});
      patch={...patch,status:'awaiting_bank_transfer'};
    }
    // Optimistic guard: one method per request. If a race occurs, do not silently overwrite a checkout.
    const {data,error}=await db.from('payment_requests').update(patch).eq('id',r.id).is('method',null).eq('status','unpaid').select('id').maybeSingle();
    if(error)throw error;
    if(!data)return res.status(409).json({error:'Another payment method was started. Refresh the page.'});
    return res.json({url:patch.checkout_url||null,manual_bank:method==='bank'&&!stripe});
  } catch(e){next(e);}
});

app.use(express.static(path.join(__dirname,'public'),{index:'index.html'}));
app.get(['/pay/:id','/admin'],(_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,_req,res,_next)=>{console.error('Server error:',err);res.status(500).json({error:'Service error. Try again later.'});});
const port=Number(process.env.PORT||10000);
app.listen(port,()=>console.log(`TriPay listening on port ${port}`));
