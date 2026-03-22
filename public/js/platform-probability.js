// ═══════════════════════════════════════════════════════════════
// FIRST-FIN: Approval Probability Display (User-Facing)
// public/js/platform-probability.js
// 
// This module ONLY displays probabilities to dealers.
// All management/logging is in the Admin panel.
// ═══════════════════════════════════════════════════════════════

(function() {
  'use strict';

  // Cache for probabilities
  window.lenderProbabilities = {};

  // ─────────────────────────────────────────────────────────────
  // FETCH ALL PROBABILITIES FOR CURRENT DEAL
  // ─────────────────────────────────────────────────────────────
  async function fetchProbabilities(beacon, ltvPct) {
    if (!beacon || beacon <= 0 || !ltvPct) return {};
    
    try {
      const res = await fetch('/api/desk/outcomes/all-probabilities', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + localStorage.getItem('ffToken')
        },
        body: JSON.stringify({ beacon, ltvPct })
      });
      const data = await res.json();
      if (data.success) {
        window.lenderProbabilities = data.probabilities;
        return data.probabilities;
      }
    } catch (e) {
      console.warn('Probabilities unavailable:', e.message);
    }
    return {};
  }

  // ─────────────────────────────────────────────────────────────
  // RENDER PROBABILITY BADGE (clean, minimal)
  // ─────────────────────────────────────────────────────────────
  function renderProbabilityBadge(probability, sampleSize) {
    if (probability === null || probability === undefined) {
      // No data - don't show anything confusing
      return '';
    }
    
    let colorClass = 'prob-low';
    let icon = '↓';
    if (probability >= 80) { colorClass = 'prob-high'; icon = '↑'; }
    else if (probability >= 60) { colorClass = 'prob-medium'; icon = '→'; }
    
    return `
      <div class="prob-display ${colorClass}" title="Based on ${sampleSize} similar deals">
        <span class="prob-pct">${probability}%</span>
        <span class="prob-label">likely</span>
      </div>
    `;
  }

  // ─────────────────────────────────────────────────────────────
  // ENHANCED LENDER CARD WITH PROBABILITY
  // Called from runComparison() to build each lender result
  // ─────────────────────────────────────────────────────────────
  function buildLenderCardWithProbability(r, prob) {
    const probability = prob?.probability;
    const sampleSize = prob?.sampleSize || 0;
    const probBadge = renderProbabilityBadge(probability, sampleSize);
    
    // Determine status
    const isEligible = r.approved;
    const statusClass = isEligible ? 'eligible' : 'ineligible';
    const statusText = isEligible ? 'ELIGIBLE' : 'NOT ELIGIBLE';
    
    // Rate display
    const rateDisplay = r.prog && r.prog.rate > 0 
      ? `${r.prog.rate}%` 
      : '—';
    
    // Payment display
    const paymentDisplay = r.payment > 0 
      ? `$${Math.round(r.payment)}/mo` 
      : '—';
    
    return `
      <div class="lender-result-card ${statusClass}" data-lender="${r.lid}">
        <div class="lrc-header">
          <div class="lrc-name">${r.l.name}</div>
          ${probBadge}
        </div>
        <div class="lrc-body">
          <div class="lrc-stat">
            <span class="lrc-stat-label">Rate</span>
            <span class="lrc-stat-value">${rateDisplay}</span>
          </div>
          <div class="lrc-stat">
            <span class="lrc-stat-label">Payment</span>
            <span class="lrc-stat-value">${paymentDisplay}</span>
          </div>
          <div class="lrc-stat">
            <span class="lrc-stat-label">LTV</span>
            <span class="lrc-stat-value ${r.ltvOk ? 'ok' : 'warn'}">${r.ltvPct.toFixed(0)}%</span>
          </div>
          <div class="lrc-stat">
            <span class="lrc-stat-label">Max</span>
            <span class="lrc-stat-value">${r.maxLTV}%</span>
          </div>
        </div>
        <div class="lrc-footer ${statusClass}">
          ${statusText}
        </div>
      </div>
    `;
  }

  // ─────────────────────────────────────────────────────────────
  // INJECT PROBABILITIES INTO EXISTING COMPARISON RESULTS
  // Alternative: patches existing rendered cards
  // ─────────────────────────────────────────────────────────────
  async function injectProbabilities() {
    const beacon = parseFloat(document.getElementById('cmp-beacon')?.value) || 0;
    const down = parseFloat(document.getElementById('cmp-down')?.value) || 0;
    const trade = parseFloat(document.getElementById('cmp-trade')?.value) || 0;
    const fees = parseFloat(document.getElementById('cmp-fees')?.value) || 0;
    const stock = document.getElementById('cmp-vehicle')?.value;
    
    if (!stock || beacon <= 0) return;
    
    const v = window.inventory?.find(x => x.stock === stock);
    if (!v) return;
    
    const bookVal = v.bookValue || v.book_value || v.price;
    const atf = v.price + fees - down - trade;
    const ltvPct = (atf / bookVal) * 100;
    
    // Fetch probabilities
    const probs = await fetchProbabilities(beacon, ltvPct);
    
    // Inject into each card
    document.querySelectorAll('[data-lender]').forEach(card => {
      const lid = card.dataset.lender;
      if (!lid || !probs[lid]) return;
      
      const prob = probs[lid];
      const badge = renderProbabilityBadge(prob.probability, prob.sampleSize);
      
      // Find or create prob display area
      const header = card.querySelector('.lrc-header') || card.querySelector('.lender-card-header');
      if (header && badge && !header.querySelector('.prob-display')) {
        header.insertAdjacentHTML('beforeend', badge);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // CSS - Clean, minimal display
  // ─────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    /* Probability display - clean and minimal */
    .prob-display {
      display: flex;
      align-items: baseline;
      gap: 4px;
      padding: 6px 12px;
      border-radius: 8px;
      margin-left: auto;
    }
    .prob-pct {
      font-size: 18px;
      font-weight: 800;
    }
    .prob-label {
      font-size: 11px;
      opacity: 0.7;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .prob-high { 
      background: rgba(34, 197, 94, 0.15); 
      color: #22c55e; 
    }
    .prob-medium { 
      background: rgba(245, 158, 11, 0.15); 
      color: #f59e0b; 
    }
    .prob-low { 
      background: rgba(239, 68, 68, 0.15); 
      color: #ef4444; 
    }
    
    /* Lender result cards (if using new card builder) */
    .lender-result-card {
      background: var(--surface, #1a1a1a);
      border: 1px solid var(--border, #333);
      border-radius: 12px;
      overflow: hidden;
      transition: all 0.2s;
    }
    .lender-result-card.eligible {
      border-color: rgba(34, 197, 94, 0.3);
    }
    .lender-result-card.ineligible {
      border-color: rgba(100, 100, 100, 0.3);
      opacity: 0.7;
    }
    .lrc-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border, #333);
    }
    .lrc-name {
      font-weight: 700;
      font-size: 14px;
    }
    .lrc-body {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1px;
      background: var(--border, #333);
    }
    .lrc-stat {
      background: var(--surface, #1a1a1a);
      padding: 12px;
      text-align: center;
    }
    .lrc-stat-label {
      display: block;
      font-size: 10px;
      color: var(--muted, #888);
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .lrc-stat-value {
      font-size: 15px;
      font-weight: 700;
    }
    .lrc-stat-value.ok { color: #22c55e; }
    .lrc-stat-value.warn { color: #ef4444; }
    .lrc-footer {
      padding: 10px;
      text-align: center;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 1px;
    }
    .lrc-footer.eligible {
      background: rgba(34, 197, 94, 0.1);
      color: #22c55e;
    }
    .lrc-footer.ineligible {
      background: rgba(100, 100, 100, 0.1);
      color: #888;
    }
  `;
  document.head.appendChild(style);

  // ─────────────────────────────────────────────────────────────
  // EXPORT TO WINDOW
  // ─────────────────────────────────────────────────────────────
  window.ProbabilityDisplay = {
    fetchProbabilities,
    renderProbabilityBadge,
    buildLenderCardWithProbability,
    injectProbabilities
  };

  console.log('✅ Probability display loaded (user-facing)');
})();
