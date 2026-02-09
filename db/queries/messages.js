const db = require('../index');

const MessageQueries = {
  /**
   * Insert a message.
   * @param {{ roomId: string, senderId: string, content?: string, messageType?: string, fileUrl?: string }} data
   * @returns {Promise<object>}
   */
  async create({ roomId, senderId, content, messageType = 'text', fileUrl }) {
    const { rows } = await db.query(
      `INSERT INTO messages (room_id, sender_id, content, message_type, file_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [roomId, senderId, content || null, messageType, fileUrl || null],
    );
    return rows[0];
  },

  /**
   * Find a message by id.
   */
  async findById(id) {
    const { rows } = await db.query('SELECT * FROM messages WHERE id = $1', [id]);
    return rows[0] || null;
  },

  /**
   * Paginated message history for a room.
   * @param {string} roomId
   * @param {{ limit?: number, before?: string }} options
   * @returns {Promise<object[]>}
   */
  async listByRoom(roomId, { limit = 50, before } = {}) {
    const params = [roomId, limit];
    let whereExtra = '';

    if (before) {
      whereExtra = 'AND m.created_at < $3';
      params.push(before);
    }

    const { rows } = await db.query(
      `SELECT m.*, u.username AS sender_username, u.profile_picture AS sender_picture,
              COALESCE(
                (SELECT CASE
                   WHEN COUNT(*) = 0 THEN 'sent'
                   WHEN MIN(CASE ms.status WHEN 'read' THEN 2 WHEN 'delivered' THEN 1 ELSE 0 END) >= 2 THEN 'read'
                   WHEN MIN(CASE ms.status WHEN 'read' THEN 2 WHEN 'delivered' THEN 1 ELSE 0 END) >= 1 THEN 'delivered'
                   ELSE 'sent'
                 END
                 FROM message_status ms WHERE ms.message_id = m.id),
                'sent'
              ) AS delivery_status
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.room_id = $1 ${whereExtra}
       ORDER BY m.created_at DESC
       LIMIT $2`,
      params,
    );
    return rows;
  },

  /**
   * Edit a message (only content, sets edited_at).
   */
  async update(id, content) {
    const { rows } = await db.query(
      `UPDATE messages SET content = $2, edited_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, content],
    );
    return rows[0] || null;
  },

  /**
   * Delete a message.
   */
  async remove(id) {
    await db.query('DELETE FROM messages WHERE id = $1', [id]);
  },

  // ---------- Read receipts ----------

  /**
   * Upsert a message status entry.
   */
  async setStatus(messageId, userId, status) {
    const { rows } = await db.query(
      `INSERT INTO message_status (message_id, user_id, status, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (message_id, user_id)
       DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()
       RETURNING *`,
      [messageId, userId, status],
    );
    return rows[0];
  },

  /**
   * Mark all messages in a room as delivered/read for a user.
   */
  async markRoomAs(roomId, userId, status) {
    await db.query(
      `INSERT INTO message_status (message_id, user_id, status, updated_at)
       SELECT m.id, $2, $3, NOW()
       FROM messages m
       WHERE m.room_id = $1 AND m.sender_id != $2
       ON CONFLICT (message_id, user_id)
       DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()
         WHERE message_status.status != $3`,
      [roomId, userId, status],
    );
  },

  /**
   * Get read receipt info for a single message.
   */
  async getStatus(messageId) {
    const { rows } = await db.query(
      `SELECT ms.*, u.username
       FROM message_status ms
       JOIN users u ON u.id = ms.user_id
       WHERE ms.message_id = $1`,
      [messageId],
    );
    return rows;
  },
};

module.exports = MessageQueries;
