// ═══════════════════════════════════════════════════════════════
// FIRST-FIN: User-Facing Probability Routes
// routes/probability.js
//
// These routes are for authenticated dealers to GET probability data.
// All management (logging, updating) is admin-only.
// ═══════════════════════════════════════════════════════════════

module.exports = function(app, pool, requireAuth, requireBilling) {

  // ─────────────────────────────────────────────────────────────
  // GET ALL PROBABILITIES FOR A DEAL PROFILE
  // Called by the comparison engine
  // ─────────────────────────────────────────────────────────────
  app.post('/api/desk/outcomes/all-probabilities', requireAuth, async (req, res) => {
    try {
      const { beacon, ltvPct } = req.body;
      
      if (!beacon || beacon <= 0) {
        return res.json({ success: true, probabilities: {} });
      }
      
      // Get approval rates for lenders with similar deals
      const result = await pool.query(`
        SELECT 
          lender_key,
          COUNT(*) FILTER (WHERE outcome != 'pending') as total,
          COUNT(*) FILTER (WHERE outcome IN ('approved', 'conditional')) as approved
        FROM deal_outcomes
        WHERE beacon BETWEEN $1 AND $2
          AND ltv_pct BETWEEN $3 AND $4
          AND outcome != 'pending'
          AND created_at > NOW() - INTERVAL '180 days'
        GROUP BY lender_key
        HAVING COUNT(*) FILTER (WHERE outcome != 'pending') >= 3
      `, [
        beacon - 30, beacon + 30,
        (ltvPct || 100) - 10, (ltvPct || 100) + 10
      ]);

      // Convert to map
      const probabilities = {};
      for (const row of result.rows) {
        const total = parseInt(row.total);
        const approved = parseInt(row.approved);
        probabilities[row.lender_key] = {
          probability: total > 0 ? Math.round((approved / total) * 100) : null,
          sampleSize: total
        };
      }

      res.json({ success: true, probabilities });
    } catch (e) {
      console.error('❌ Probability query error:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // GET DETAILED PROBABILITY FOR SINGLE LENDER
  // For "Why?" explanations
  // ─────────────────────────────────────────────────────────────
  app.post('/api/desk/outcomes/probability', requireAuth, async (req, res) => {
    try {
      const { lenderKey, beacon, ltvPct } = req.body;

      if (!lenderKey || !beacon || beacon <= 0) {
        return res.json({ 
          success: true, 
          probability: null, 
          confidence: 'none',
          explanation: 'Insufficient data'
        });
      }

      // Query similar deals
      const result = await pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE outcome IN ('approved', 'conditional')) as approved,
          ROUND(AVG(ltv_pct) FILTER (WHERE outcome = 'approved'), 1) as avg_ltv,
          ROUND(AVG(approved_rate) FILTER (WHERE outcome = 'approved'), 2) as avg_rate
        FROM deal_outcomes
        WHERE lender_key = $1
          AND beacon BETWEEN $2 AND $3
          AND ltv_pct BETWEEN $4 AND $5
          AND outcome != 'pending'
          AND created_at > NOW() - INTERVAL '180 days'
      `, [
        lenderKey,
        beacon - 30, beacon + 30,
        (ltvPct || 100) - 10, (ltvPct || 100) + 10
      ]);

      const data = result.rows[0] || {};
      const total = parseInt(data.total) || 0;
      const approved = parseInt(data.approved) || 0;

      let probability = null;
      let confidence = 'none';
      let explanation = 'No historical data for this profile.';

      if (total >= 5) {
        probability = Math.round((approved / total) * 100);
        confidence = 'high';
        explanation = `Based on ${total} similar deals (beacon ${beacon}±30, LTV ${Math.round(ltvPct)}%±10%).`;
        if (data.avg_ltv) {
          explanation += ` Avg approved LTV: ${data.avg_ltv}%.`;
        }
      } else if (total >= 3) {
        probability = Math.round((approved / total) * 100);
        confidence = 'medium';
        explanation = `Based on ${total} deals. Limited sample size.`;
      }

      res.json({
        success: true,
        lenderKey,
        probability,
        confidence,
        sampleSize: total,
        explanation,
        avgApprovedRate: data.avg_rate || null
      });
    } catch (e) {
      console.error('❌ Single probability error:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── LOG APPROVAL from dealer (called when applying lender approval) ──
  app.post('/api/desk/outcomes/log-approval', requireAuth, requireBilling, async (req, res) => {
    try {
      const uid = req.user.userId;
      const {
        lenderKey, outcome, beacon, ltvPct,
        vehicleYear, vehicleMileage, vehiclePrice, bookValue,
        amountToFinance, term, approvedRate, approvedTerm, approvedAmount,
        stipulations, customerName, stock
      } = req.body;

      if (!lenderKey) {
        return res.status(400).json({ success: false, error: 'lenderKey required' });
      }

      const validOutcomes = ['approved', 'conditional', 'declined', 'pending'];
      const finalOutcome  = validOutcomes.includes(outcome) ? outcome : 'approved';

      const result = await pool.query(`
        INSERT INTO deal_outcomes (
          user_id, lender_key, outcome, beacon, ltv_pct,
          vehicle_year, vehicle_mileage, vehicle_price, book_value,
          amount_to_finance, term, approved_rate, approved_term, approved_amount,
          stipulations, customer_name, stock,
          submitted_at, responded_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW())
        RETURNING id
      `, [
        uid, lenderKey, finalOutcome,
        beacon          || null,
        ltvPct          || null,
        vehicleYear     || null,
        vehicleMileage  || null,
        vehiclePrice    || null,
        bookValue       || null,
        amountToFinance || null,
        term            || null,
        approvedRate    || null,
        approvedTerm    || null,
        approvedAmount  || null,
        stipulations    || null,
        customerName    || null,
        stock           || null
      ]);

      console.log(`✅ Approval logged: ${lenderKey} → ${finalOutcome} (dealer:${uid}, #${result.rows[0].id})`);
      res.json({ success: true, outcomeId: result.rows[0].id });
    } catch (e) {
      console.error('❌ log-approval error:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  console.log('✅ Probability routes mounted (user-facing, read-only)');
};
