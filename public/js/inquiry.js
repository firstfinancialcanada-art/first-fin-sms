// ── Platform Inquiry / Request Access ────────────────────────────
// Handles all "Get Started", "Request Access", "Get in Touch" flows

function showPlatformInquiry(e) {
  if (e) e.preventDefault();

  // Close any open modals
  var exitModal = document.getElementById('demo-exit-modal');
  if (exitModal) exitModal.style.display = 'none';

  // Show the login overlay
  var overlay = document.getElementById('ff-login-overlay');
  if (overlay) overlay.style.display = 'flex';

  // Hide login form, show register form directly (no FF dependency)
  var loginForm = document.getElementById('ff-login-form');
  var regForm   = document.getElementById('ff-reg-form');
  var regSuccess = document.getElementById('ff-reg-success');

  if (loginForm)  loginForm.style.display  = 'none';
  if (regForm)    regForm.style.display    = 'block';
  if (regSuccess) regSuccess.style.display = 'none';

  // Clear any previous errors
  var errEl = document.getElementById('ff-reg-error');
  if (errEl) errEl.style.display = 'none';

  // Reset button
  var btn = document.getElementById('ff-reg-btn');
  if (btn) { btn.textContent = 'Request Access'; btn.disabled = false; }
}

async function handlePlatformInquiry(e) {
  if (e) e.preventDefault();

  var name       = (document.getElementById('ff-reg-name')        || {}).value || '';
  var dealership = (document.getElementById('ff-reg-dealership')   || {}).value || '';
  var phone      = (document.getElementById('ff-reg-phone')        || {}).value || '';
  var email      = (document.getElementById('ff-reg-email')        || {}).value || '';
  var errEl      = document.getElementById('ff-reg-error');
  var btn        = document.getElementById('ff-reg-btn');

  name = name.trim(); dealership = dealership.trim(); phone = phone.trim(); email = email.trim();

  if (!name || !dealership || !phone) {
    if (errEl) { errEl.textContent = 'Please fill in your name, dealership, and phone.'; errEl.style.display = 'block'; }
    return;
  }

  if (btn) { btn.textContent = 'Sending...'; btn.disabled = true; }

  try {
    var res  = await fetch('/api/request-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, dealership: dealership, phone: phone, email: email })
    });
    var data = await res.json();
    if (data.success) {
      var regForm    = document.getElementById('ff-reg-form');
      var regSuccess = document.getElementById('ff-reg-success');
      if (regForm)    regForm.style.display    = 'none';
      if (regSuccess) regSuccess.style.display = 'block';
    } else {
      if (errEl) { errEl.textContent = data.error || 'Something went wrong. Please try again.'; errEl.style.display = 'block'; }
      if (btn)   { btn.textContent = 'Request Access'; btn.disabled = false; }
    }
  } catch(err) {
    if (errEl) { errEl.textContent = 'Network error. Please try again.'; errEl.style.display = 'block'; }
    if (btn)   { btn.textContent = 'Request Access'; btn.disabled = false; }
  }
}

