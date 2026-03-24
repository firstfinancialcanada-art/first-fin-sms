// ═══════════════════════════════════════════════════════════════
// FIRST-FIN: Outcome Management (Admin Routes)
// routes/outcomes-admin.js
//
// These routes require admin token auth, not user JWT.
// For operator-only access to logging and management.
// ═══════════════════════════════════════════════════════════════

// ── Error sanitizer — never leak DB internals to client ──────────
function sanitizeError(e) {
  console.error('Route error:', e);
  return 'An unexpected error occurred. Please try again.';
}

module.exports = function(app, pool) {
  
  // Admin auth middleware (same as admin-dashboard.js)
  function adminAuth(req, res, next) {
    const token = req.headers['x-admin-token'] || req.query.token;
    if (!token || token !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    next();
  }

  // ─────────────────────────────────────────────────────────────
  // GET OUTCOME STATS (for admin dashboard cards)
  // ─────────────────────────────────────────────────────────────
  app.get('/api/admin/outcome-stats', adminAuth, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE outcome = 'pending') as pending,
          COUNT(*) FILTER (WHERE outcome IN ('approved', 'conditional')) as approved,
          COUNT(*) FILTER (WHERE outcome = 'declined') as declined,
          ROUND(
            COUNT(*) FILTER (WHERE outcome IN ('approved', 'conditional')) * 100.0 /
            NULLIF(COUNT(*) FILTER (WHERE outcome != 'pending'), 0)
          ) as approval_rate
        FROM deal_outcomes
        WHERE created_at > NOW() - INTERVAL '180 days'
      `);
      
      const stats = result.rows[0] || {};
      res.json({
        success: true,
        stats: {
          total: parseInt(stats.total) || 0,
          pending: parseInt(stats.pending) || 0,
          approved: parseInt(stats.approved) || 0,
          declined: parseInt(stats.declined) || 0,
          approvalRate: stats.approval_rate ? parseInt(stats.approval_rate) : null
        }
      });
    } catch (e) {
      console.error('❌ Admin outcome stats error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // GET PENDING OUTCOMES (across all tenants)
  // ─────────────────────────────────────────────────────────────
  app.get('/api/admin/pending-outcomes', adminAuth, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          o.id, o.stock, o.customer_name, o.lender_key, 
          o.beacon, o.ltv_pct, o.amount_to_finance,
          o.submitted_at, o.user_id,
          u.display_name as tenant_name,
          EXTRACT(EPOCH FROM (NOW() - o.submitted_at)) / 3600 as hours_pending
        FROM deal_outcomes o
        LEFT JOIN desk_users u ON o.user_id = u.id
        WHERE o.outcome = 'pending'
        ORDER BY o.submitted_at DESC
        LIMIT 50
      `);
      
      res.json({ success: true, pending: result.rows });
    } catch (e) {
      console.error('❌ Admin pending outcomes error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // UPDATE OUTCOME (admin can update any outcome)
  // ─────────────────────────────────────────────────────────────
  app.post('/api/admin/update-outcome', adminAuth, async (req, res) => {
    try {
      const {
        outcomeId,
        outcome,
        approvedRate,
        approvedTerm,
        approvedAmount,
        stipulations,
        declineReasons,
        conditions
      } = req.body;

      const validOutcomes = ['approved', 'declined', 'conditional', 'withdrawn'];
      if (!validOutcomes.includes(outcome)) {
        return res.status(400).json({ success: false, error: 'Invalid outcome' });
      }

      const result = await pool.query(`
        UPDATE deal_outcomes SET
          outcome = $1,
          approved_rate = $2,
          approved_term = $3,
          approved_amount = $4,
          stipulations = $5,
          decline_reasons = $6,
          conditions = $7,
          responded_at = NOW()
        WHERE id = $8
        RETURNING *
      `, [
        outcome,
        approvedRate || null,
        approvedTerm || null,
        approvedAmount || null,
        stipulations || null,
        declineReasons || null,
        conditions || null,
        outcomeId
      ]);

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Outcome not found' });
      }

      console.log(`📋 Admin updated outcome #${outcomeId} → ${outcome.toUpperCase()}`);
      res.json({ success: true, outcome: result.rows[0] });
    } catch (e) {
      console.error('❌ Admin update outcome error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // LOG NEW OUTCOME (admin quick-log)
  // ─────────────────────────────────────────────────────────────
  app.post('/api/admin/log-outcome', adminAuth, async (req, res) => {
    try {
      const {
        lenderKey, outcome, beacon, ltvPct,
        vehicleYear, vehicleMileage, vehiclePrice, bookValue,
        amountToFinance, term, approvedRate,
        stipulations, declineReasons, customerName, stock,
        userId  // optional: which tenant this belongs to (defaults to admin/1)
      } = req.body;

      const result = await pool.query(`
        INSERT INTO deal_outcomes (
          user_id, lender_key, outcome, beacon, ltv_pct,
          vehicle_year, vehicle_mileage, vehicle_price, book_value,
          amount_to_finance, term, approved_rate,
          stipulations, decline_reasons, customer_name, stock,
          submitted_at, responded_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())
        RETURNING id
      `, [
        userId || null,  // null = platform-level outcome (no specific tenant)
        lenderKey, 
        outcome, 
        beacon || null, 
        ltvPct || null,
        vehicleYear || null, 
        vehicleMileage || null, 
        vehiclePrice || null, 
        bookValue || null,
        amountToFinance || null, 
        term || null, 
        approvedRate || null,
        stipulations || null, 
        declineReasons || null, 
        customerName || null, 
        stock || null
      ]);

      console.log(`📝 Admin logged outcome: ${lenderKey} → ${outcome} (#${result.rows[0].id})`);
      res.json({ success: true, outcomeId: result.rows[0].id });
    } catch (e) {
      console.error('❌ Admin log outcome error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // LENDER STATS (aggregate performance by lender)
  // ─────────────────────────────────────────────────────────────
  app.get('/api/admin/lender-stats', adminAuth, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          lender_key,
          COUNT(*) as total_deals,
          COUNT(*) FILTER (WHERE outcome = 'approved') as approved,
          COUNT(*) FILTER (WHERE outcome = 'declined') as declined,
          COUNT(*) FILTER (WHERE outcome = 'conditional') as conditional,
          COUNT(*) FILTER (WHERE outcome = 'pending') as pending,
          ROUND(
            COUNT(*) FILTER (WHERE outcome IN ('approved', 'conditional')) * 100.0 / 
            NULLIF(COUNT(*) FILTER (WHERE outcome != 'pending'), 0)
          ) as approval_rate,
          ROUND(AVG(approved_rate) FILTER (WHERE outcome = 'approved'), 2) as avg_rate,
          ROUND(AVG(EXTRACT(EPOCH FROM (responded_at - submitted_at)) / 3600) 
            FILTER (WHERE responded_at IS NOT NULL), 1) as avg_response_hours
        FROM deal_outcomes
        WHERE created_at > NOW() - INTERVAL '180 days'
        GROUP BY lender_key
        ORDER BY total_deals DESC
      `);

      res.json({ success: true, stats: result.rows });
    } catch (e) {
      console.error('❌ Admin lender stats error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // RECENT OUTCOMES (full history view)
  // ─────────────────────────────────────────────────────────────
  app.get('/api/admin/recent-outcomes', adminAuth, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 100;
      
      const result = await pool.query(`
        SELECT 
          o.id, o.stock, o.customer_name, o.lender_key, 
          o.beacon, o.ltv_pct, o.amount_to_finance, o.term,
          o.outcome, o.approved_rate, o.stipulations, o.decline_reasons,
          o.submitted_at, o.responded_at, o.funded_at,
          o.user_id, u.display_name as tenant_name,
          EXTRACT(EPOCH FROM (o.responded_at - o.submitted_at)) / 3600 as response_hours
        FROM deal_outcomes o
        LEFT JOIN desk_users u ON o.user_id = u.id
        ORDER BY o.created_at DESC
        LIMIT $1
      `, [limit]);

      res.json({ success: true, outcomes: result.rows });
    } catch (e) {
      console.error('❌ Admin recent outcomes error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // DELETE OUTCOME (admin only)
  // ─────────────────────────────────────────────────────────────
  app.delete('/api/admin/outcome/:id', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      
      const result = await pool.query(
        'DELETE FROM deal_outcomes WHERE id = $1 RETURNING id',
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Not found' });
      }

      console.log(`🗑️ Admin deleted outcome #${id}`);
      res.json({ success: true, deleted: id });
    } catch (e) {
      console.error('❌ Admin delete outcome error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  console.log('✅ Admin outcomes routes mounted on /api/admin/*');
};
