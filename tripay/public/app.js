const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = cents => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents / 100);
function showToast(message) { toast.textContent=message;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),4500); }
async function api(url, options={}) {
  let res;
  try { res = await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json',...options.headers},...options}); }
  catch { throw new Error('Could not reach the server'); }
  const payload = await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(payload.error || 'Request failed');
  return payload;
}
function statusLabel(s){return s==='awaiting_bank_transfer'?'Bank transfer pending':s==='awaiting_payment'?'Payment pending':s==='unpaid'?'Unpaid':'Paid';}
function badge(s){return `<span class="status ${escapeHTML(s)}">${escapeHTML(statusLabel(s))}</span>`;}
async function copyText(t) {try{await navigator.clipboard.writeText(t);showToast('Payment link copied');}catch{showToast('Unable to copy. Select the link manually.');}}
function home() {
  app.innerHTML=`<div class="page"><section class="hero"><div class="eyebrow">Three ways to get paid</div><h1>Payments made simple, wherever your customers are.</h1><p>Create secure payment requests in US dollars and let customers choose card, cryptocurrency, or an approved bank payment method.</p><a href="/admin" class="button primary">Open merchant dashboard →</a></section><section class="features"><div class="feature"><div class="glyph">💳</div><h3>Visa & Mastercard</h3><p>Hosted card checkout. Eligible banks can request a passkey, biometric approval, or other verification.</p></div><div class="feature"><div class="glyph">₿</div><h3>Real cryptocurrency</h3><p>Customers receive a provider-generated payment address on the correct network. Never ask for wallet seed phrases.</p></div><div class="feature"><div class="glyph">🏦</div><h3>US bank & transfers</h3><p>ACH through an eligible merchant account, or independently reconciled bank transfers.</p></div></section></div>`;
}
function login(){
  app.innerHTML=`<div class="page"><div class="login-layout"><div class="panel"><div class="eyebrow">Merchant access</div><h2>Sign in</h2><p class="muted">Use your merchant administrator account. Customer payments never require merchant sign-in.</p><form class="form" id="loginForm"><div class="field"><label>Email</label><input required type="email" name="email" autocomplete="username" placeholder="owner@business.com"></div><div class="field"><label>Password</label><input required type="password" name="password" autocomplete="current-password" placeholder="Your password"></div><button class="button primary full" type="submit">Sign in to dashboard</button><p id="loginError" class="error" role="alert"></p></form></div></div></div>`;
  document.querySelector('#loginForm').addEventListener('submit',async e=>{
    e.preventDefault();const f=new FormData(e.currentTarget);const button=e.currentTarget.querySelector('button');button.disabled=true;
    try{await api('/api/admin/login',{method:'POST',body:JSON.stringify({email:f.get('email'),password:f.get('password')})});await dashboard();}
    catch(error){document.querySelector('#loginError').textContent=error.message;}finally{button.disabled=false;}
  });
}
async function dashboard(){
  let list=[];
  try{const d=await api('/api/admin/requests');list=d.items||[];}catch(error){showToast(error.message);return login();}
  const items=list.map(r=>{
    const link=`${location.origin}/pay/${r.id}`;
    const canConfirm=r.status==='awaiting_bank_transfer' && !r.provider_reference;
    return `<article class="request-item"><div class="row"><div><strong>${escapeHTML(r.description)}</strong><div class="item-caption">${escapeHTML(r.customer_email)} · ${new Date(r.created_at).toLocaleDateString()}</div></div><div style="text-align:right"><div class="money">${fmt(r.amount_cents)}</div>${badge(r.status)}</div></div><div class="links"><a href="${link}" class="button small" target="_blank" rel="noopener">View payment page</a><a class="button small" href="mailto:${encodeURIComponent(r.customer_email)}?subject=${encodeURIComponent('Payment request: '+r.description)}&body=${encodeURIComponent('Please review and authorize your payment of '+fmt(r.amount_cents)+' at: '+link)}">Email link</a><button type="button" class="button small copy" data-copy="${escapeHTML(link)}">Copy link</button>${canConfirm?`<button type="button" class="button small bank-confirm" data-id="${escapeHTML(r.id)}">Confirm verified transfer</button>`:''}</div></article>`;
  }).join('');
  app.innerHTML=`<div class="page"><div class="headline"><div><div class="eyebrow">Merchant workspace</div><h1>Payment requests</h1><p class="muted">Create a request, share the link, track confirmed payments.</p></div><button class="button small" id="logout">Sign out</button></div><div class="layout"><section class="panel"><h2>Create request</h2><p class="muted">All requests are in USD. You control the amount and the description.</p><form class="form" id="createForm"><div class="field"><label>Customer email</label><input required type="email" name="email" placeholder="customer@example.com"></div><div class="field"><label>Customer name (optional)</label><input name="name" maxlength="120" placeholder="Customer name"></div><div class="field"><label>Amount (USD)</label><input required type="number" name="amount" min="1" max="1000000" step="0.01" placeholder="150.00"></div><div class="field"><label>What are they paying for?</label><textarea name="description" required maxlength="280" placeholder="e.g. Consulting services, invoice #001"></textarea></div><button class="button primary full" type="submit">Create payment link →</button><div id="created"></div></form></section><section class="panel"><div class="row"><div><h2>Recent requests</h2><p class="muted" style="margin:0">${list.length} requests shown</p></div><span class="status">USD</span></div><div class="admin-list">${items||'<div class="empty">No payment requests yet. Create your first one.</div>'}</div></section></div></div>`;
  document.querySelector('#logout').addEventListener('click',async()=>{try{await api('/api/admin/logout',{method:'POST'});}catch{}login();});
  document.querySelectorAll('.copy').forEach(btn=>btn.addEventListener('click',()=>copyText(btn.dataset.copy)));
  document.querySelectorAll('.bank-confirm').forEach(btn=>btn.addEventListener('click',async()=>{
    const ref=window.prompt('Enter the bank statement reference ONLY after independently verifying that the full amount has cleared into your business bank account:');
    if(!ref)return;
    if(!window.confirm('Did you independently verify that the money actually arrived? This marks the request PAID.'))return;
    btn.disabled=true;
    try{await api(`/api/admin/requests/${btn.dataset.id}/confirm-bank`,{method:'POST',body:JSON.stringify({bank_reference:ref})});showToast('Manual bank transfer marked verified');await dashboard();}catch(e){showToast(e.message);btn.disabled=false;}
  }));
  document.querySelector('#createForm').addEventListener('submit',async e=>{
    e.preventDefault();const f=new FormData(e.currentTarget);const btn=e.currentTarget.querySelector('button[type=submit]');btn.disabled=true;
    try{
      const d=await api('/api/admin/requests',{method:'POST',body:JSON.stringify({email:f.get('email'),name:f.get('name'),amount:f.get('amount'),description:f.get('description')})});
      document.querySelector('#created').innerHTML=`<div class="notice"><strong>Created successfully</strong><p class="idtext">${escapeHTML(d.link)}</p><button class="button small" type="button" id="copyNew">Copy payment link</button></div>`;
      document.querySelector('#copyNew').addEventListener('click',()=>copyText(d.link));showToast('Payment request created');
      // Preserve new link in view; show refreshed list on next load.
    }catch(error){showToast(error.message);}finally{btn.disabled=false;}
  });
}
function bankInfo(details){
  const labels=[['Beneficiary',details.account_name],['Bank name',details.bank_name],['Account number',details.account_number],['SWIFT/BIC',details.swift],['Routing number',details.routing],['Branch',details.branch],['Reference',details.payment_reference],['Notes',details.notes]];
  return `<div class="notice">Use your bank's official app or website to send a transfer. Use the exact payment reference and do not share banking passwords or one-time codes.</div><dl class="bank-detail">${labels.filter(([_,v])=>v).map(([k,v])=>`<dt>${escapeHTML(k)}</dt><dd>${escapeHTML(v)}</dd>`).join('')}</dl><div class="spacer"></div><p class="footnote">The merchant will mark this request paid only after verifying funds in their bank statement. An upload or screenshot is not payment confirmation.</p>`;
}
async function payment(id){
  let data;
  try{data=await api('/api/requests/'+encodeURIComponent(id));}
  catch{app.innerHTML='<div class="page"><div class="panel payment-shell"><h2>Request not found</h2><p class="muted">Check that the link is correct.</p></div></div>';return;}
  const r=data.request;
  const paid=r.status==='paid';
  const pending=r.status!=='unpaid' && !paid;
  const methods=[['card','💳','Visa or Mastercard','Pay by card; bank may prompt for verification'],['crypto','₿','Cryptocurrency','Pay with crypto on a supported blockchain network'],['bank','🏦','Bank payment','US ACH (if available) or bank transfer instructions']];
  const options=methods.filter(([k])=>data.available[k]).map(([k,icon,title,desc])=>`<button type="button" class="method" data-method="${k}"><span class="icon">${icon}</span><span><strong>${title}</strong><small>${desc}</small></span><span class="arrow">›</span></button>`).join('');
  let content=paid?`<div class="success">✓ Payment confirmed</div><p class="footnote">This payment was verified by the payment provider or manually reconciled by the merchant.</p>`:pending?`<div class="notice">${escapeHTML(statusLabel(r.status))}. Your payment will show as paid after confirmation.</div>${r.method==='bank' && data.bank_details ? bankInfo(data.bank_details):r.checkout_url?`<div class="spacer"></div><a class="button primary full" href="${escapeHTML(r.checkout_url)}" rel="noopener noreferrer">Continue ${r.method==='crypto'?'crypto':r.method==='bank'?'bank':'card'} checkout →</a>`:''}`:`<h3>Choose how to pay</h3>${options||'<p class="muted">No payment methods are configured yet. Contact the merchant.</p>'}<p class="footnote">You will review details and authorize the payment through a trusted provider. Never enter a passkey or bank password into this site.</p>`;
  app.innerHTML=`<div class="page"><div class="payment-shell"><div class="invoice-head"><div class="circle">✦</div><h1>Payment request</h1><p>Requested by ${escapeHTML(data.merchant_name)} · Review the amount before continuing</p></div><div class="panel invoice-panel"><div class="invoice-summary"><div class="tag">Total due · USD</div><div class="amount">${fmt(r.amount_cents)}</div><div class="desc">${escapeHTML(r.description)}</div><div style="margin-top:13px">${badge(r.status)}</div></div><div class="invoice-options">${content}</div></div><p class="footnote">Request reference: ${escapeHTML(r.id.slice(0,8).toUpperCase())}<br>Payment is never complete merely because a checkout link was opened.</p></div></div>`;
  document.querySelectorAll('[data-method]').forEach(btn=>btn.addEventListener('click',async()=>{
    btn.disabled=true;const method=btn.dataset.method;
    try{
      const result=await api(`/api/requests/${encodeURIComponent(id)}/checkout`,{method:'POST',body:JSON.stringify({method})});
      if(result.url){location.assign(result.url);return;}
      if(result.manual_bank){await payment(id);return;}
      showToast('Payment initiated');await payment(id);
    }catch(e){showToast(e.message);btn.disabled=false;}
  }));
}
(async()=>{
  const path=location.pathname;
  if(/^\/pay\/[0-9a-f-]{36}$/i.test(path))await payment(path.split('/').pop());
  else if(path==='/admin'){
    try{await api('/api/admin/me');await dashboard();}catch{login();}
  }else home();
})();
