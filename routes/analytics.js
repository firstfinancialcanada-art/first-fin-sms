// routes/analytics.js
const { pool } = require('../lib/db');

// CSV formula injection prevention — prefix dangerous leading chars with tab
function csvSafe(val) {
  const s = String(val || '').replace(/"/g, '""'); // escape inner quotes
  if (/^[=+\-@\t\r]/.test(s)) return '"' + '\t' + s + '"';
  return '"' + s + '"';
}

// ── Error sanitizer — never leak DB internals to client ──────────
function sanitizeError(e) {
  console.error('Route error:', e);
  return 'An unexpected error occurred. Please try again.';
}

module.exports = function analyticsRoutes(app, { requireAuth, notifyOwner }) {

  // ── Test notification ─────────────────────────────────────────
  app.get('/test-notify', async (req, res) => {
    if (req.query.token !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    try {
      const result = await notifyOwner('🧪 Test notification from FIRST-FIN Platform — ' + new Date().toLocaleString());
      res.json({ success: result, message: result ? '✅ SMS sent to your phone!' : '❌ FORWARD_PHONE not set' });
    } catch (error) {
      res.json({ success: false, error: error.message });
    }
  });

  // ── Export appointments ───────────────────────────────────────
  app.get('/api/export/appointments', requireAuth, async (req, res) => {
    const uid = req.user.userId;
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT * FROM appointments WHERE user_id = $1 ORDER BY created_at DESC', [uid]);
      const rows = [['ID', 'Phone', 'Name', 'Vehicle', 'Budget', 'Amount', 'DateTime', 'Created'].join(',')];
      result.rows.forEach(r => rows.push([r.id, csvSafe(r.customer_phone), csvSafe(r.customer_name), csvSafe(r.vehicle_type), csvSafe(r.budget), r.budget_amount||'', csvSafe(r.datetime), csvSafe(r.created_at)].join(',')));
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="appointments_' + new Date().toISOString().split('T')[0] + '.csv"');
      res.send(rows.join('\n'));
    } catch (e) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="appointments_error.csv"');
      res.send('Error,Message\n"Export Failed","' + e.message + '"');
    } finally { client.release(); }
  });

  // ── Export callbacks ──────────────────────────────────────────
  app.get('/api/export/callbacks', requireAuth, async (req, res) => {
    const uid = req.user.userId;
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT * FROM callbacks WHERE user_id = $1 ORDER BY created_at DESC', [uid]);
      const rows = [['ID', 'Phone', 'Name', 'Vehicle', 'Budget', 'Amount', 'DateTime', 'Created'].join(',')];
      result.rows.forEach(r => rows.push([r.id, csvSafe(r.customer_phone), csvSafe(r.customer_name), csvSafe(r.vehicle_type), csvSafe(r.budget), r.budget_amount||'', csvSafe(r.datetime), csvSafe(r.created_at)].join(',')));
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="callbacks_' + new Date().toISOString().split('T')[0] + '.csv"');
      res.send(rows.join('\n'));
    } catch (e) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="callbacks_error.csv"');
      res.send('Error,Message\n"Export Failed","' + e.message + '"');
    } finally { client.release(); }
  });

  // ── Export conversations ──────────────────────────────────────
  app.get('/api/export/conversations', requireAuth, async (req, res) => {
    const uid = req.user.userId;
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT * FROM conversations WHERE user_id = $1 ORDER BY started_at DESC', [uid]);
      const rows = [['ID', 'Phone', 'Status', 'Name', 'Vehicle', 'Budget', 'Started', 'Updated'].join(',')];
      result.rows.forEach(r => rows.push([r.id, csvSafe(r.customer_phone), csvSafe(r.status), csvSafe(r.customer_name), csvSafe(r.vehicle_type), csvSafe(r.budget), csvSafe(r.started_at), csvSafe(r.updated_at)].join(',')));
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="conversations_' + new Date().toISOString().split('T')[0] + '.csv"');
      res.send(rows.join('\n'));
    } catch (e) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="conversations_error.csv"');
      res.send('Error,Message\n"Export Failed","' + e.message + '"');
    } finally { client.release(); }
  });

  // ── Export analytics (admin) ──────────────────────────────────
  app.get('/api/export/analytics', async (req, res) => {
    if (req.query.token !== process.env.ADMIN_TOKEN) {
      return res.status(403).send('Forbidden: invalid token');
    }
    const client = await pool.connect();
    try {
      const totalConvs      = await client.query('SELECT COUNT(*) as count FROM conversations');
      const totalConversations = parseInt(totalConvs.rows[0].count);
      const converted       = await client.query("SELECT COUNT(*) as count FROM conversations WHERE status = 'converted'");
      const totalConverted  = parseInt(converted.rows[0].count);
      const responded       = await client.query("SELECT COUNT(DISTINCT conversation_id) as count FROM messages WHERE role = 'user'");
      const totalResponded  = parseInt(responded.rows[0].count);
      const totalAppts      = await client.query('SELECT COUNT(*) as count FROM appointments');
      const appointmentCount = parseInt(totalAppts.rows[0].count);
      const totalCalls      = await client.query('SELECT COUNT(*) as count FROM callbacks');
      const callbackCount   = parseInt(totalCalls.rows[0].count);
      const avgMsgs         = await client.query("SELECT COALESCE(AVG(msg_count), 0)::numeric(10,1) as avg FROM (SELECT conversation_id, COUNT(*) as msg_count FROM messages GROUP BY conversation_id) as counts");
      const avgMessages     = parseFloat(avgMsgs.rows[0].avg || 0);
      const statusBreakdown = await client.query("SELECT status, COUNT(*) as count FROM conversations GROUP BY status ORDER BY count DESC");
      const topVehicles     = await client.query("SELECT vehicle_type, COUNT(*) as count FROM conversations WHERE vehicle_type IS NOT NULL AND vehicle_type != '' GROUP BY vehicle_type ORDER BY count DESC LIMIT 10");
      const budgetRanges    = await client.query("SELECT budget, COUNT(*) as count FROM conversations WHERE budget IS NOT NULL AND budget != '' GROUP BY budget ORDER BY count DESC");
      const dailyTrend      = await client.query(`SELECT DATE(started_at) as date, COUNT(*) as conversations, COUNT(CASE WHEN status = 'converted' THEN 1 END) as converted FROM conversations WHERE started_at >= NOW() - INTERVAL '30 days' GROUP BY DATE(started_at) ORDER BY date DESC`);
      const engagement      = await client.query(`SELECT CASE WHEN msg_count >= 5 THEN 'High Engagement (5+ messages)' WHEN msg_count >= 2 THEN 'Medium Engagement (2-4 messages)' WHEN msg_count = 1 THEN 'Low Engagement (1 message)' ELSE 'No Response' END as engagement_level, COUNT(*) as count FROM (SELECT c.id, COUNT(m.id) as msg_count FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id AND m.role = 'user' GROUP BY c.id) as engagement_counts GROUP BY engagement_level ORDER BY count DESC`);

      const rows = [];
      rows.push('SUMMARY METRICS'); rows.push('Metric,Value');
      rows.push(`Total Conversations,${totalConversations}`);
      rows.push(`Total Converted (Appointments + Callbacks),${totalConverted}`);
      rows.push(`Conversion Rate,${totalConversations > 0 ? ((totalConverted / totalConversations) * 100).toFixed(1) : '0.0'}%`);
      rows.push(`Customers Who Responded,${totalResponded}`);
      rows.push(`Response Rate,${totalConversations > 0 ? ((totalResponded / totalConversations) * 100).toFixed(1) : '0.0'}%`);
      rows.push(`Total Appointments,${appointmentCount}`);
      rows.push(`Total Callbacks,${callbackCount}`);
      rows.push(`Average Messages Per Conversation,${avgMessages.toFixed(1)}`);
      rows.push('');
      rows.push('CONVERSATION STATUS BREAKDOWN'); rows.push('Status,Count,Percentage');
      statusBreakdown.rows.forEach(r => { const pct = totalConversations > 0 ? ((r.count / totalConversations) * 100).toFixed(1) : '0.0'; rows.push(`${csvSafe(r.status)},${r.count},${pct}%`); });
      rows.push('');
      rows.push('TOP VEHICLE TYPES REQUESTED'); rows.push('Vehicle Type,Count');
      topVehicles.rows.forEach(r => rows.push(`${csvSafe(r.vehicle_type)},${r.count}`));
      rows.push('');
      rows.push('BUDGET DISTRIBUTION'); rows.push('Budget Range,Count');
      budgetRanges.rows.forEach(r => rows.push(`${csvSafe(r.budget)},${r.count}`));
      rows.push('');
      rows.push('CUSTOMER ENGAGEMENT LEVELS'); rows.push('Engagement Level,Count');
      engagement.rows.forEach(r => rows.push(`${csvSafe(r.engagement_level)},${r.count}`));
      rows.push('');
      rows.push('DAILY CONVERSATION TREND (Last 30 Days)'); rows.push('Date,Total Conversations,Converted,Conversion Rate');
      dailyTrend.rows.forEach(r => { const convRate = r.conversations > 0 ? ((r.converted / r.conversations) * 100).toFixed(1) : '0.0'; rows.push(`${r.date},${r.conversations},${r.converted},${convRate}%`); });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="analytics_report_' + new Date().toISOString().split('T')[0] + '.csv"');
      res.send(rows.join('\n'));
    } catch (e) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="analytics_error.csv"');
      res.send('Error,Message\n"Export Failed","' + e.message + '"');
    } finally { client.release(); }
  });

  // ── Analytics dashboard data ──────────────────────────────────
  app.get('/api/analytics', requireAuth, async (req, res) => {
    const uid = req.user.userId;
    const client = await pool.connect();
    try {
      const totalConvs  = await client.query('SELECT COUNT(*) as count FROM conversations WHERE user_id = $1', [uid]);
      const totalConversations = parseInt(totalConvs.rows[0].count);
      const converted   = await client.query("SELECT COUNT(*) as count FROM conversations WHERE status = 'converted' AND user_id = $1", [uid]);
      const totalConverted = parseInt(converted.rows[0].count);
      const responded   = await client.query("SELECT COUNT(DISTINCT m.conversation_id) as count FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.role = 'user' AND c.user_id = $1", [uid]);
      const totalResponded = parseInt(responded.rows[0].count);
      const avgMsgs     = await client.query("SELECT COALESCE(AVG(msg_count), 0)::numeric(10,1) as avg FROM (SELECT conversation_id, COUNT(*) as msg_count FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = $1 GROUP BY conversation_id) as counts", [uid]);
      const avgMessages = parseFloat(avgMsgs.rows[0].avg || 0);
      const weekConvs   = await client.query("SELECT COUNT(*) as count FROM conversations WHERE started_at >= NOW() - INTERVAL '7 days' AND user_id = $1", [uid]);
      const weekConversations = parseInt(weekConvs.rows[0].count);
      const weekConverted = await client.query("SELECT COUNT(*) as count FROM conversations WHERE status = 'converted' AND started_at >= NOW() - INTERVAL '7 days' AND user_id = $1", [uid]);
      const weekConvertedCount = parseInt(weekConverted.rows[0].count);
      const topVehicles = await client.query("SELECT vehicle_type, COUNT(*) as count FROM conversations WHERE vehicle_type IS NOT NULL AND vehicle_type != '' AND user_id = $1 GROUP BY vehicle_type ORDER BY count DESC LIMIT 5", [uid]);
      const budgets     = await client.query("SELECT budget, COUNT(*) as count FROM conversations WHERE budget IS NOT NULL AND budget != '' AND user_id = $1 GROUP BY budget ORDER BY count DESC", [uid]);
      // ── New: engaged count, stage funnel, weekly trend ─────────
      const engaged = await client.query(
        "SELECT COUNT(*) as count FROM conversations WHERE status = 'engaged' AND user_id = $1", [uid]);
      const totalEngaged = parseInt(engaged.rows[0].count);

      const stopped = await client.query(
        "SELECT COUNT(*) as count FROM conversations WHERE status = 'stopped' AND user_id = $1", [uid]);
      const totalStopped = parseInt(stopped.rows[0].count);

      // Stage funnel
      const funnel = await client.query(`
        SELECT stage, COUNT(*) as count
        FROM conversations WHERE user_id = $1 AND status NOT IN ('stopped')
        GROUP BY stage ORDER BY count DESC`, [uid]);

      // Weekly trend — conversations started per week for last 8 weeks
      const weeklyTrend = await client.query(`
        SELECT
          DATE_TRUNC('week', started_at) as week_start,
          COUNT(*) as conversations,
          COUNT(*) FILTER (WHERE status = 'converted') as converted
        FROM conversations WHERE user_id = $1
          AND started_at >= NOW() - INTERVAL '8 weeks'
        GROUP BY week_start ORDER BY week_start ASC`, [uid]);

      // Deal desk analytics from desk_deal_log JSONB
      const dealStats = await client.query(`
        SELECT
          COUNT(*) as total_deals,
          COUNT(*) FILTER (WHERE (deal_data->'products'->>'vscPrice')::numeric > 0) as vsc_count,
          COUNT(*) FILTER (WHERE (deal_data->'products'->>'gapPrice')::numeric > 0) as gap_count,
          COUNT(*) FILTER (WHERE (deal_data->'products'->>'twPrice')::numeric > 0) as tw_count,
          COUNT(*) FILTER (WHERE (deal_data->'products'->>'waPrice')::numeric > 0) as wa_count,
          AVG(
            COALESCE((deal_data->'products'->>'vscPrice')::numeric,0) +
            COALESCE((deal_data->'products'->>'gapPrice')::numeric,0) +
            COALESCE((deal_data->'products'->>'twPrice')::numeric,0) +
            COALESCE((deal_data->'products'->>'waPrice')::numeric,0)
          ) as avg_backend,
          AVG(COALESCE((deal_data->>'pvr')::numeric,0)) as avg_pvr,
          COUNT(*) FILTER (WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())) as month_deals,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as week_deals,
          COUNT(*) FILTER (WHERE DATE_TRUNC('day', created_at) = DATE_TRUNC('day', NOW())) as today_deals
        FROM desk_deal_log WHERE user_id = $1`, [uid]);

      const ds = dealStats.rows[0];

      // Vehicle type breakdown from deal log
      const dealVehicleTypes = await client.query(`
        SELECT deal_data->'vehicle'->>'type' as type, COUNT(*) as count
        FROM desk_deal_log WHERE user_id = $1
          AND deal_data->'vehicle'->>'type' IS NOT NULL
          AND deal_data->'vehicle'->>'type' != ''
        GROUP BY type ORDER BY count DESC LIMIT 6`, [uid]);

      res.json({
        conversionRate: totalConversations > 0 ? ((totalConverted / totalConversations) * 100).toFixed(1) : '0.0',
        totalConverted, totalConversations,
        totalEngaged, totalStopped,
        responseRate: totalConversations > 0 ? ((totalResponded / totalConversations) * 100).toFixed(1) : '0.0',
        totalResponded, avgMessages: avgMessages.toFixed(1),
        weekConversations, weekConverted: weekConvertedCount,
        topVehicles: topVehicles.rows, budgetDist: budgets.rows,
        stageFunnel: funnel.rows,
        weeklyTrend: weeklyTrend.rows,
        dealStats: {
          totalDeals:   parseInt(ds.total_deals  || 0),
          monthDeals:   parseInt(ds.month_deals  || 0),
          weekDeals:    parseInt(ds.week_deals   || 0),
          todayDeals:   parseInt(ds.today_deals  || 0),
          vscCount:     parseInt(ds.vsc_count    || 0),
          gapCount:     parseInt(ds.gap_count    || 0),
          twCount:      parseInt(ds.tw_count     || 0),
          waCount:      parseInt(ds.wa_count     || 0),
          avgBackend:   parseFloat(ds.avg_backend || 0).toFixed(0),
          avgPvr:       parseFloat(ds.avg_pvr    || 0).toFixed(0),
        },
        dealVehicleTypes: dealVehicleTypes.rows
      });
    } catch (error) {
      console.error('❌ Analytics error:', error);
      res.json({ error: error.message });
    } finally { client.release(); }
  });

  // ── Export engaged leads ──────────────────────────────────────
  app.get('/api/export/engaged', requireAuth, async (req, res) => {
    const uid = req.user.userId;
    const client = await pool.connect();
    try {
      const result = await client.query(`SELECT DISTINCT c.* FROM conversations c JOIN messages m ON m.conversation_id = c.id WHERE m.role = 'user' AND c.user_id = $1 ORDER BY c.started_at DESC`, [uid]);
      const rows = [['ID', 'Phone', 'Status', 'Name', 'Vehicle', 'Budget', 'Started', 'Updated'].join(',')];
      result.rows.forEach(r => {
        rows.push([r.id, csvSafe(r.customer_phone), csvSafe(r.status), csvSafe(r.customer_name), csvSafe(r.vehicle_type), csvSafe(r.budget), csvSafe(r.started_at), csvSafe(r.updated_at)].join(','));
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="engaged_' + new Date().toISOString().split('T')[0] + '.csv"');
      res.send(rows.join('\n'));
    } catch (e) {
      res.status(500).send('Export failed');
    } finally { client.release(); }
  });

};

