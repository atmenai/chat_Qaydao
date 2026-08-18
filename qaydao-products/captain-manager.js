// QAYDAO Captain Manager
// Connects to Chatwoot PostgreSQL to manage Captain AI documents, FAQs, scenarios
const { Pool } = require('pg');

const chatwootPool = new Pool({
  host: process.env.CHATWOOT_PG_HOST || '127.0.0.1',
  port: parseInt(process.env.CHATWOOT_PG_PORT) || 5437,
  database: process.env.CHATWOOT_PG_DB || 'chatwoot_production',
  user: process.env.CHATWOOT_PG_USER || 'chatwoot_user',
  password: process.env.CHATWOOT_PG_PASSWORD || 'f5c0e58555c94b08befed4db5643cb89d549983e9d9e132d',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

const ACCOUNT_ID = 1;
const ASSISTANT_ID = 1;

chatwootPool.on('error', err => console.error('[Chatwoot PG]', err.message));

// ────────────────────────────────────────────────────────────
//  EMBEDDING GENERATOR (OpenAI text-embedding-3-small, 1536d)
// ────────────────────────────────────────────────────────────
async function generateEmbedding(text) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const r = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
    encoding_format: 'float'
  });
  return r.data[0].embedding;
}

function vectorLiteral(arr) {
  // pgvector accepts string literal like "[0.1,0.2,...]"
  return '[' + arr.join(',') + ']';
}


// ────────────────────────────────────────────────────────────
//  DOCUMENTS
// ────────────────────────────────────────────────────────────

async function listDocuments() {
  const { rows } = await chatwootPool.query(`
    SELECT id, name, external_link, content, status, sync_status,
           created_at, updated_at, last_synced_at,
           LENGTH(content) AS content_length
    FROM captain_documents
    WHERE assistant_id = $1
    ORDER BY id
  `, [ASSISTANT_ID]);

  return rows.map(d => ({
    id: d.id,
    name: d.name,
    external_link: d.external_link,
    content: d.content,
    content_length: d.content_length,
    status: d.status,
    status_label: { 0: 'في الانتظار', 1: 'متاح', 2: 'فشل', 3: 'in_progress' }[d.status] || 'غير معروف',
    sync_status: d.sync_status,
    created_at: d.created_at,
    updated_at: d.updated_at,
    last_synced_at: d.last_synced_at
  }));
}

async function getDocument(id) {
  const { rows } = await chatwootPool.query(`
    SELECT * FROM captain_documents WHERE id = $1 AND assistant_id = $2
  `, [id, ASSISTANT_ID]);
  return rows[0] || null;
}

async function createDocument({ name, external_link, content }) {
  if (!name || !external_link) throw new Error('name and external_link are required');

  // Generate a unique external_link if user only provided a name
  const finalLink = external_link.startsWith('http')
    ? external_link
    : `https://qaydao.com/internal/${external_link.replace(/[^a-z0-9-_]/gi, '-')}`;

  const { rows } = await chatwootPool.query(`
    INSERT INTO captain_documents (name, external_link, content, status, sync_status, assistant_id, account_id, created_at, updated_at)
    VALUES ($1, $2, $3, 1, 0, $4, $5, NOW(), NOW())
    ON CONFLICT (assistant_id, external_link) DO UPDATE
    SET name = EXCLUDED.name, content = EXCLUDED.content, updated_at = NOW(), status = 1
    RETURNING *
  `, [name, finalLink, content || '', ASSISTANT_ID, ACCOUNT_ID]);

  return rows[0];
}

async function updateDocument(id, { name, content, external_link }) {
  // Only update fields that were provided
  const updates = [];
  const values = [];
  let idx = 1;

  if (name !== undefined) { updates.push(`name = $${idx++}`); values.push(name); }
  if (content !== undefined) { updates.push(`content = $${idx++}`); values.push(content); }
  if (external_link !== undefined) { updates.push(`external_link = $${idx++}`); values.push(external_link); }

  if (updates.length === 0) throw new Error('No fields to update');

  updates.push(`updated_at = NOW()`);
  updates.push(`status = 1`); // Mark as available after edit

  values.push(id);
  values.push(ASSISTANT_ID);

  const { rows } = await chatwootPool.query(`
    UPDATE captain_documents
    SET ${updates.join(', ')}
    WHERE id = $${idx++} AND assistant_id = $${idx}
    RETURNING *
  `, values);

  return rows[0];
}

async function deleteDocument(id) {
  const { rowCount } = await chatwootPool.query(`
    DELETE FROM captain_documents WHERE id = $1 AND assistant_id = $2
  `, [id, ASSISTANT_ID]);
  return rowCount > 0;
}

// ────────────────────────────────────────────────────────────
//  FAQ RESPONSES
// ────────────────────────────────────────────────────────────

async function listFAQs() {
  const { rows } = await chatwootPool.query(`
    SELECT id, question, answer, status, edited, documentable_id, documentable_type,
           created_at, updated_at, reviewed, reviewed_at, reviewed_by_id
    FROM captain_assistant_responses
    WHERE assistant_id = $1
    ORDER BY id DESC
  `, [ASSISTANT_ID]);

  return rows.map(f => ({
    ...f,
    status_label: { 0: 'في الانتظار', 1: 'معتمد' }[f.status] || 'غير معروف'
  }));
}

async function createFAQ({ question, answer }) {
  if (!question || !answer) throw new Error('question and answer required');

  const { rows } = await chatwootPool.query(`
    INSERT INTO captain_assistant_responses
      (question, answer, status, edited, assistant_id, account_id, created_at, updated_at)
    VALUES ($1, $2, 1, TRUE, $3, $4, NOW(), NOW())
    RETURNING *
  `, [question, answer, ASSISTANT_ID, ACCOUNT_ID]);

  return rows[0];
}

async function updateFAQ(id, { question, answer, status }) {
  const updates = [];
  const values = [];
  let idx = 1;

  if (question !== undefined) { updates.push(`question = $${idx++}`); values.push(question); }
  if (answer !== undefined) { updates.push(`answer = $${idx++}`); values.push(answer); }
  if (status !== undefined) { updates.push(`status = $${idx++}`); values.push(status); }

  if (updates.length === 0) throw new Error('No fields to update');

  updates.push(`edited = TRUE`);
  updates.push(`updated_at = NOW()`);

  values.push(id);
  values.push(ASSISTANT_ID);

  const { rows } = await chatwootPool.query(`
    UPDATE captain_assistant_responses
    SET ${updates.join(', ')}
    WHERE id = $${idx++} AND assistant_id = $${idx}
    RETURNING *
  `, values);

  return rows[0];
}

async function deleteFAQ(id) {
  const { rowCount } = await chatwootPool.query(`
    DELETE FROM captain_assistant_responses WHERE id = $1 AND assistant_id = $2
  `, [id, ASSISTANT_ID]);
  return rowCount > 0;
}

// QAYDAO: team review tracking (reviewed flag; reviewed_at stamped, cleared on un-review).
// Studio has a single shared admin session, so reviewed_by_id is reset to NULL here
// (the Chatwoot dashboard patch stamps the real user when toggled from there).
async function setFAQReviewed(id, reviewed) {
  const val = reviewed === true || reviewed === 'true';
  const { rows } = await chatwootPool.query(`
    UPDATE captain_assistant_responses
    SET reviewed = $1,
        reviewed_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
        reviewed_by_id = NULL
    WHERE id = $2 AND assistant_id = $3
    RETURNING id, reviewed, reviewed_at
  `, [val, id, ASSISTANT_ID]);
  return rows[0];
}

// ────────────────────────────────────────────────────────────
//  CUSTOM TOOLS (read-only here - edit via Chatwoot)
// ────────────────────────────────────────────────────────────

async function listTools() {
  const { rows } = await chatwootPool.query(`
    SELECT id, slug, title, description, http_method, endpoint_url, enabled,
           created_at, updated_at
    FROM captain_custom_tools
    WHERE account_id = $1
    ORDER BY id
  `, [ACCOUNT_ID]);
  return rows;
}

// ────────────────────────────────────────────────────────────
//  ASSISTANT CONFIG
// ────────────────────────────────────────────────────────────

async function getAssistant() {
  const { rows } = await chatwootPool.query(`
    SELECT id, name, description, config FROM captain_assistants WHERE id = $1
  `, [ASSISTANT_ID]);
  return rows[0];
}

async function updateAssistantInstructions(instructions) {
  // Get current config
  const { rows } = await chatwootPool.query(`
    SELECT config FROM captain_assistants WHERE id = $1
  `, [ASSISTANT_ID]);

  const config = rows[0]?.config || {};
  config.instruction = instructions;

  await chatwootPool.query(`
    UPDATE captain_assistants
    SET config = $1, updated_at = NOW()
    WHERE id = $2
  `, [config, ASSISTANT_ID]);

  return config;
}

// ────────────────────────────────────────────────────────────
//  STATISTICS
// ────────────────────────────────────────────────────────────

async function getStats() {
  const [docs, faqs, tools, conv] = await Promise.all([
    chatwootPool.query(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM captain_documents WHERE assistant_id = $1`, [ASSISTANT_ID]),
    chatwootPool.query(`SELECT COUNT(*) AS n FROM captain_assistant_responses WHERE assistant_id = $1`, [ASSISTANT_ID]),
    chatwootPool.query(`SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE enabled = TRUE) AS active FROM captain_custom_tools WHERE account_id = $1`, [ACCOUNT_ID]),
    chatwootPool.query(`SELECT COUNT(*) AS n FROM captain_inboxes WHERE captain_assistant_id = $1`, [ASSISTANT_ID])
  ]);

  return {
    documents: {
      total: parseInt(docs.rows[0].n),
      total_bytes: parseInt(docs.rows[0].bytes),
      total_kb: Math.round(parseInt(docs.rows[0].bytes) / 1024 * 10) / 10
    },
    faqs: { total: parseInt(faqs.rows[0].n) },
    tools: { total: parseInt(tools.rows[0].n), active: parseInt(tools.rows[0].active) },
    inboxes: { connected: parseInt(conv.rows[0].n) }
  };
}


// ────────────────────────────────────────────────────────────
//  LIVE REPLIES — Captain conversation history viewer
// ────────────────────────────────────────────────────────────

async function listCaptainReplies({ limit = 50, channel = null, since_hours = 24, conversation_id = null, since_id = null } = {}) {
  const convId = parseInt(conversation_id) || null;
  const sinceId = parseInt(since_id) || null;
  // البحث برقم محادثة يتجاوز النافذة الزمنية (10 سنوات) لتظهر المحادثات القديمة
  const params = [ASSISTANT_ID, convId ? 87600 : since_hours, parseInt(limit) || 50];
  let channelFilter = '';
  if (channel && channel !== 'all') {
    channelFilter = 'AND i.channel_type = $' + (params.length + 1);
    params.push(channel);
  }
  let convFilter = '';
  if (convId) {
    convFilter = 'AND m.conversation_id = $' + (params.length + 1);
    params.push(convId);
  }
  let sinceIdFilter = '';
  if (sinceId) {
    sinceIdFilter = 'AND m.id > $' + (params.length + 1);
    params.push(sinceId);
  }

  const sql = `
    WITH captain_msgs AS (
      SELECT
        m.id AS captain_msg_id,
        m.content AS captain_reply,
        m.created_at AS captain_at,
        m.conversation_id,
        m.inbox_id,
        m.content_attributes
      FROM messages m
      WHERE m.sender_type = 'Captain::Assistant'
        AND m.created_at > NOW() - ($2 || ' hours')::interval
        ${convFilter}
        ${sinceIdFilter}
        AND (m.private = false OR m.private IS NULL)
        AND m.content NOT LIKE 'Auto-handoff:%'
        AND m.content NOT LIKE '%إنهاء هذه المحادثة%'
        AND LENGTH(TRIM(m.content)) > 0
        AND EXISTS (
          SELECT 1 FROM captain_inboxes ci
          WHERE ci.inbox_id = m.inbox_id AND ci.captain_assistant_id = $1
        )
    ),
    last_customer_msg AS (
      SELECT DISTINCT ON (cm.captain_msg_id)
        cm.captain_msg_id,
        m2.content AS customer_question,
        m2.created_at AT TIME ZONE 'UTC' AS customer_at
      FROM captain_msgs cm
      LEFT JOIN messages m2
        ON m2.conversation_id = cm.conversation_id
        AND m2.message_type = 0
        AND m2.id < cm.captain_msg_id
      ORDER BY cm.captain_msg_id, m2.id DESC
    )
    SELECT
      cm.captain_msg_id,
      cm.conversation_id,
      cm.captain_at AT TIME ZONE 'UTC' AS reply_at,
      i.name AS inbox_name,
      i.channel_type,
      cont.name AS customer_name,
      cont.phone_number AS customer_phone,
      lcm.customer_question,
      cm.captain_reply,
      cm.content_attributes,
      c.status AS conv_status,
      (cm.captain_reply ILIKE '%unfortunately%'
        OR cm.captain_reply ILIKE '% the customer %'
        OR cm.captain_reply ILIKE '%I apologize%'
        OR cm.captain_reply ILIKE '%I cannot%'
        OR cm.captain_reply ILIKE '%here are some%') AS flag_english,
      (cm.captain_reply LIKE '%![%') AS flag_broken_md
    FROM captain_msgs cm
    JOIN inboxes i ON i.id = cm.inbox_id
    JOIN conversations c ON c.id = cm.conversation_id
    LEFT JOIN contacts cont ON cont.id = c.contact_id
    LEFT JOIN last_customer_msg lcm ON lcm.captain_msg_id = cm.captain_msg_id
    WHERE 1=1 ${channelFilter}
    ORDER BY cm.captain_at DESC
    LIMIT $3
  `;

  const { rows } = await chatwootPool.query(sql, params);
  return rows;
}

async function getRepliesStats(since_hours = 24) {
  const { rows } = await chatwootPool.query(`
    SELECT
      COUNT(*) AS total_replies,
      COUNT(DISTINCT m.conversation_id) AS conversations_touched,
      COUNT(*) FILTER (WHERE m.content ILIKE '%handoff%' OR m.content ILIKE '%تحويل%' OR m.content ILIKE '%أحوّلك%') AS handoffs,
      COUNT(*) FILTER (WHERE m.created_at > NOW() - INTERVAL '1 hour') AS last_hour,
      MIN(m.created_at) AT TIME ZONE 'Asia/Riyadh' AS oldest,
      MAX(m.created_at) AT TIME ZONE 'Asia/Riyadh' AS newest
    FROM messages m
    WHERE m.sender_type = 'Captain::Assistant'
      AND m.created_at > NOW() - ($1 || ' hours')::interval
      AND EXISTS (
        SELECT 1 FROM captain_inboxes ci
        WHERE ci.inbox_id = m.inbox_id AND ci.captain_assistant_id = $2
      )
  `, [since_hours, ASSISTANT_ID]);
  return rows[0];
}

async function getRepliesByChannel(since_hours = 24) {
  const { rows } = await chatwootPool.query(`
    SELECT
      i.channel_type,
      i.name AS inbox_name,
      COUNT(m.*) AS replies
    FROM messages m
    JOIN inboxes i ON i.id = m.inbox_id
    WHERE m.sender_type = 'Captain::Assistant'
      AND m.created_at > NOW() - ($1 || ' hours')::interval
      AND EXISTS (
        SELECT 1 FROM captain_inboxes ci
        WHERE ci.inbox_id = m.inbox_id AND ci.captain_assistant_id = $2
      )
    GROUP BY i.channel_type, i.name
    ORDER BY replies DESC
  `, [since_hours, ASSISTANT_ID]);
  return rows;
}


// ────────────────────────────────────────────────────────────
//  LEARNING — pending suggestions from agent-handled convs
// ────────────────────────────────────────────────────────────

async function listLearningSuggestions(status = 'pending', limit = 50) {
  const { rows } = await chatwootPool.query(`
    SELECT cls.*, 
           c.status AS conv_status
    FROM captain_learning_suggestions cls
    LEFT JOIN conversations c ON c.id = cls.conversation_id
    WHERE cls.status = $1
    ORDER BY cls.created_at DESC
    LIMIT $2
  `, [status, limit]);
  return rows;
}

async function getLearningSuggestion(id) {
  const { rows } = await chatwootPool.query(
    'SELECT * FROM captain_learning_suggestions WHERE id = $1',
    [id]
  );
  return rows[0];
}

async function approveLearningSuggestion(id, { question, answer, reviewer }) {
  return await chatwootPool.query('BEGIN').then(async () => {
    try {
      const sug = await getLearningSuggestion(id);
      if (!sug) throw new Error('suggestion not found');
      if (sug.status === 'approved') throw new Error('already approved');
      
      const finalQ = (question || sug.suggested_question || '').trim();
      const finalA = (answer || sug.suggested_answer || '').trim();
      if (!finalQ || !finalA) throw new Error('question or answer is empty');
      
      // Insert as FAQ
      const { rows: faqRows } = await chatwootPool.query(`
        INSERT INTO captain_assistant_responses
          (account_id, assistant_id, question, answer, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        RETURNING id
      `, [sug.account_id, sug.assistant_id, finalQ, finalA, 1]);
      const faqId = faqRows[0].id;
      
      // Generate embedding synchronously (Rails callback doesn't fire for raw INSERT)
      const embText = finalQ + ': ' + finalA;
      const vec = await generateEmbedding(embText);
      await chatwootPool.query(
        'UPDATE captain_assistant_responses SET embedding = $1::vector WHERE id = $2',
        [vectorLiteral(vec), faqId]
      );
      
      // Mark suggestion as approved
      await chatwootPool.query(`
        UPDATE captain_learning_suggestions
        SET status = 'approved',
            suggested_question = $1,
            suggested_answer = $2,
            reviewed_by = $3,
            reviewed_at = NOW(),
            created_faq_id = $4,
            updated_at = NOW()
        WHERE id = $5
      `, [finalQ, finalA, reviewer || 'admin', faqId, id]);
      
      await chatwootPool.query('COMMIT');
      
      // Trigger embedding (sync would be safer but requires Rails - we trust the FAQ embedding listener)
      // The Captain::AssistantResponse model's after_create_commit will enqueue UpdateEmbeddingJob automatically
      
      return { success: true, faq_id: faqId };
    } catch (err) {
      await chatwootPool.query('ROLLBACK');
      throw err;
    }
  });
}

async function rejectLearningSuggestion(id, { reason, reviewer }) {
  await chatwootPool.query(`
    UPDATE captain_learning_suggestions
    SET status = 'rejected',
        rejection_reason = $1,
        reviewed_by = $2,
        reviewed_at = NOW(),
        updated_at = NOW()
    WHERE id = $3 AND status = 'pending'
  `, [reason || 'manual', reviewer || 'admin', id]);
  return { success: true };
}

async function getLearningStats() {
  const { rows } = await chatwootPool.query(`
    SELECT status, COUNT(*) AS n
    FROM captain_learning_suggestions
    GROUP BY status
  `);
  const stats = { pending: 0, approved: 0, rejected: 0, edited: 0 };
  rows.forEach(r => { stats[r.status] = parseInt(r.n); });
  return stats;
}

async function fetchConversationContext(conversation_id) {
  const { rows } = await chatwootPool.query(`
    SELECT m.id, m.content, m.message_type, m.sender_type, 
           m.created_at, 
           CASE m.sender_type
             WHEN 'Contact' THEN cont.name
             WHEN 'User' THEN u.name
             WHEN 'Captain::Assistant' THEN 'QAYDAO AI'
             ELSE m.sender_type
           END AS sender_name
    FROM messages m
    LEFT JOIN contacts cont ON cont.id = m.sender_id AND m.sender_type = 'Contact'
    LEFT JOIN users u ON u.id = m.sender_id AND m.sender_type = 'User'
    WHERE m.conversation_id = $1
      AND (m.private = false OR m.private IS NULL)
    ORDER BY m.id
    LIMIT 50
  `, [conversation_id]);
  return rows;
}


// ────────────────────────────────────────────────────────────
//  REPLY CONTROL — full employee control over Captain replies
// ────────────────────────────────────────────────────────────

// Get a single reply with full conversation context + the handoff reason
async function getReplyDetail(msgId) {
  const { rows: msgRows } = await chatwootPool.query(`
    SELECT m.id, m.conversation_id, m.content, m.inbox_id,
           m.created_at AT TIME ZONE 'Asia/Riyadh' AS created_at,
           i.channel_type, i.name AS inbox_name,
           cont.name AS customer_name, cont.phone_number
    FROM messages m
    JOIN inboxes i ON i.id = m.inbox_id
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN contacts cont ON cont.id = c.contact_id
    WHERE m.id = $1
  `, [msgId]);
  if (!msgRows[0]) throw new Error('reply not found');
  const reply = msgRows[0];

  // The customer question right before this reply
  const { rows: qRows } = await chatwootPool.query(`
    SELECT content FROM messages
    WHERE conversation_id = $1 AND message_type = 0 AND id < $2
    ORDER BY id DESC LIMIT 1
  `, [reply.conversation_id, msgId]);
  reply.customer_question = qRows[0]?.content || null;

  // Full conversation thread (visible messages only)
  const { rows: thread } = await chatwootPool.query(`
    SELECT m.id, m.content, m.message_type, m.sender_type, m.private,
           m.created_at AT TIME ZONE 'Asia/Riyadh' AS created_at,
           CASE m.sender_type
             WHEN 'Contact' THEN cont.name
             WHEN 'User' THEN u.name
             WHEN 'Captain::Assistant' THEN 'QAYDAO AI'
             ELSE m.sender_type
           END AS sender_name
    FROM messages m
    LEFT JOIN contacts cont ON cont.id = m.sender_id AND m.sender_type = 'Contact'
    LEFT JOIN users u ON u.id = m.sender_id AND m.sender_type = 'User'
    WHERE m.conversation_id = $1
    ORDER BY m.id
    LIMIT 80
  `, [reply.conversation_id]);
  reply.thread = thread;

  return reply;
}

// فتح محادثة كاملة برقمها مباشرة — حتى لو لم يكن للكابتن رد داخلها
async function getConversationThread(conversation_id) {
  const convId = parseInt(conversation_id) || null;
  if (!convId) throw new Error('conversation_id required');

  const { rows: metaRows } = await chatwootPool.query(`
    SELECT c.id AS conversation_id, c.status AS conv_status, c.inbox_id,
           i.name AS inbox_name, i.channel_type,
           cont.name AS customer_name, cont.phone_number AS customer_phone,
           c.created_at AT TIME ZONE 'UTC' AS conv_created_at
    FROM conversations c
    JOIN inboxes i ON i.id = c.inbox_id
    LEFT JOIN contacts cont ON cont.id = c.contact_id
    WHERE c.id = $1
  `, [convId]);
  if (!metaRows[0]) throw new Error('conversation not found');

  const { rows: thread } = await chatwootPool.query(`
    SELECT m.id, m.content, m.message_type, m.sender_type, m.private,
           m.created_at AT TIME ZONE 'UTC' AS created_at,
           CASE m.sender_type
             WHEN 'Contact' THEN cont.name
             WHEN 'User' THEN u.name
             WHEN 'Captain::Assistant' THEN 'QAYDAO AI'
             ELSE m.sender_type
           END AS sender_name
    FROM messages m
    LEFT JOIN contacts cont ON cont.id = m.sender_id AND m.sender_type = 'Contact'
    LEFT JOIN users u ON u.id = m.sender_id AND m.sender_type = 'User'
    WHERE m.conversation_id = $1
    ORDER BY m.id
    LIMIT 200
  `, [convId]);

  return { ...metaRows[0], thread_count: thread.length, thread };
}

// "Teach": take a customer question + the correct answer, add it as a FAQ
// so Captain answers correctly next time. Generates embedding synchronously.
async function teachFromReply({ question, answer, reviewer, source_msg_id }) {
  const finalQ = (question || '').trim();
  const finalA = (answer || '').trim();
  if (!finalQ || !finalA) throw new Error('question and answer are required');

  await chatwootPool.query('BEGIN');
  try {
    const { rows } = await chatwootPool.query(`
      INSERT INTO captain_assistant_responses
        (account_id, assistant_id, question, answer, status, edited, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 1, TRUE, NOW(), NOW())
      RETURNING id
    `, [ACCOUNT_ID, ASSISTANT_ID, finalQ, finalA]);
    const faqId = rows[0].id;

    // Embedding (raw INSERT bypasses Rails callback)
    const vec = await generateEmbedding(finalQ + ': ' + finalA);
    await chatwootPool.query(
      'UPDATE captain_assistant_responses SET embedding = $1::vector WHERE id = $2',
      [vectorLiteral(vec), faqId]
    );

    // Log into learning_suggestions as approved (audit trail)
    if (source_msg_id) {
      await chatwootPool.query(`
        INSERT INTO captain_learning_suggestions
          (conversation_id, account_id, assistant_id, original_question, original_agent_reply,
           suggested_question, suggested_answer, ai_reasoning, status, reviewed_by, reviewed_at, created_faq_id)
        SELECT m.conversation_id, $1, $2, $3, m.content, $3, $4,
               'تصحيح يدوي من لوحة الردود', 'approved', $5, NOW(), $6
        FROM messages m WHERE m.id = $7
        ON CONFLICT (conversation_id, original_question) DO NOTHING
      `, [ACCOUNT_ID, ASSISTANT_ID, finalQ, finalA, reviewer || 'admin', faqId, source_msg_id]);
    }

    await chatwootPool.query('COMMIT');
    return { success: true, faq_id: faqId };
  } catch (err) {
    await chatwootPool.query('ROLLBACK');
    throw err;
  }
}

// Find which FAQ (if any) most likely produced a given reply — for editing at source
async function findRelatedFAQ(replyText) {
  // Simple heuristic: find FAQ whose answer shares the most words with reply
  const { rows } = await chatwootPool.query(`
    SELECT id, question, answer,
           similarity(answer, $1) AS sim
    FROM captain_assistant_responses
    WHERE assistant_id = $2
    ORDER BY sim DESC
    LIMIT 3
  `, [replyText.slice(0, 500), ASSISTANT_ID]).catch(() => ({ rows: [] }));
  return rows;
}


// ────────────────────────────────────────────────────────────
//  MAINTENANCE MODE — pause/resume Captain from the dashboard
// ────────────────────────────────────────────────────────────
const { execFile } = require("child_process");
const fsSync = require("fs");

const MAINTENANCE_FLAG = "/root/chat-qaydao/captain-config/MAINTENANCE";
const PAUSE_SCRIPT = "/root/chat-qaydao/captain-config/scripts/pause.sh";
const RESUME_SCRIPT = "/root/chat-qaydao/captain-config/scripts/resume.sh";

async function getCaptainStatus() {
  // Paused if the flag exists OR no inbox bindings
  const flagExists = fsSync.existsSync(MAINTENANCE_FLAG);
  let bindings = 0;
  try {
    const { rows } = await chatwootPool.query(
      "SELECT COUNT(*)::int AS n FROM captain_inboxes WHERE captain_assistant_id = $1",
      [ASSISTANT_ID]
    );
    bindings = rows[0].n;
  } catch (e) { /* ignore */ }

  let pausedAt = null, pausedBy = null;
  if (flagExists) {
    try {
      const txt = fsSync.readFileSync(MAINTENANCE_FLAG, "utf-8");
      pausedAt = (txt.match(/paused_at=(.+)/) || [])[1] || null;
      pausedBy = (txt.match(/paused_by=(.+)/) || [])[1] || null;
    } catch (e) { /* ignore */ }
  }

  return {
    paused: flagExists,
    active_channels: bindings,
    paused_at: pausedAt,
    paused_by: pausedBy,
  };
}

function runScript(scriptPath) {
  return new Promise((resolve, reject) => {
    execFile("/bin/bash", [scriptPath], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message).slice(-500)));
      resolve((stdout || "").slice(-1000));
    });
  });
}

async function pauseCaptain() {
  const out = await runScript(PAUSE_SCRIPT);
  return { success: true, paused: true, output: out };
}

async function resumeCaptain() {
  const out = await runScript(RESUME_SCRIPT);
  return { success: true, paused: false, output: out };
}

module.exports = {
  // Documents
  listDocuments, getDocument, createDocument, updateDocument, deleteDocument,
  // FAQs
  listFAQs, createFAQ, updateFAQ, deleteFAQ, setFAQReviewed,
  // Tools (read-only)
  listTools,
  // Assistant
  getAssistant, updateAssistantInstructions,
  // Replies viewer
  listCaptainReplies, getRepliesStats, getRepliesByChannel,
  // Reply control
  getReplyDetail, getConversationThread, teachFromReply, findRelatedFAQ,
  // Maintenance
  getCaptainStatus, pauseCaptain, resumeCaptain,
  // Learning
  listLearningSuggestions, getLearningSuggestion, approveLearningSuggestion,
  rejectLearningSuggestion, getLearningStats, fetchConversationContext,
  // Stats
  getStats,
  // Direct DB access
  pool: chatwootPool
};
