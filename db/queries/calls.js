const db = require('../index');

const CallQueries = {
  /**
   * Create a call record when a call starts.
   * @param {{ roomId: string, initiatorId: string, callType: 'audio'|'video' }} data
   * @returns {Promise<object>}
   */
  async create({ roomId, initiatorId, callType }) {
    const { rows } = await db.query(
      `INSERT INTO calls (room_id, initiator_id, call_type, status)
       VALUES ($1, $2, $3, 'ringing')
       RETURNING *`,
      [roomId, initiatorId, callType],
    );
    return rows[0];
  },

  /**
   * Find a call by id.
   */
  async findById(id) {
    const { rows } = await db.query('SELECT * FROM calls WHERE id = $1', [id]);
    return rows[0] || null;
  },

  /**
   * Update the status of a call (ringing -> ongoing -> completed, etc).
   */
  async updateStatus(id, status) {
    const extra = ['completed', 'missed', 'rejected'].includes(status)
      ? ', ended_at = NOW()'
      : '';
    const { rows } = await db.query(
      `UPDATE calls SET status = $2 ${extra} WHERE id = $1 RETURNING *`,
      [id, status],
    );
    return rows[0] || null;
  },

  /**
   * End a call (sets ended_at and status to completed).
   */
  async end(id) {
    return this.updateStatus(id, 'completed');
  },

  /**
   * Add a participant to a call.
   */
  async addParticipant(callId, userId) {
    const { rows } = await db.query(
      `INSERT INTO call_participants (call_id, user_id, answered)
       VALUES ($1, $2, FALSE)
       RETURNING *`,
      [callId, userId],
    );
    return rows[0];
  },

  /**
   * Mark a participant as having answered.
   */
  async answerParticipant(callId, userId) {
    const { rows } = await db.query(
      `UPDATE call_participants
       SET answered = TRUE, joined_at = NOW()
       WHERE call_id = $1 AND user_id = $2
       RETURNING *`,
      [callId, userId],
    );
    return rows[0] || null;
  },

  /**
   * Mark a participant as having left.
   */
  async removeParticipant(callId, userId) {
    await db.query(
      `UPDATE call_participants SET left_at = NOW()
       WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [callId, userId],
    );
  },

  /**
   * Get participants of a call.
   */
  async getParticipants(callId) {
    const { rows } = await db.query(
      `SELECT cp.*, u.username, u.profile_picture
       FROM call_participants cp
       JOIN users u ON u.id = cp.user_id
       WHERE cp.call_id = $1
       ORDER BY cp.joined_at`,
      [callId],
    );
    return rows;
  },

  /**
   * Call history for a user (paginated).
   */
  async listByUser(userId, { limit = 30, offset = 0 } = {}) {
    const { rows } = await db.query(
      `SELECT c.*, u.username AS initiator_username
       FROM calls c
       JOIN call_participants cp ON cp.call_id = c.id
       JOIN users u ON u.id = c.initiator_id
       WHERE cp.user_id = $1
       ORDER BY c.started_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return rows;
  },

  /**
   * Call history for a room (paginated).
   */
  async listByRoom(roomId, { limit = 30, offset = 0 } = {}) {
    const { rows } = await db.query(
      `SELECT c.*, u.username AS initiator_username
       FROM calls c
       JOIN users u ON u.id = c.initiator_id
       WHERE c.room_id = $1
       ORDER BY c.started_at DESC
       LIMIT $2 OFFSET $3`,
      [roomId, limit, offset],
    );
    return rows;
  },
};

module.exports = CallQueries;
