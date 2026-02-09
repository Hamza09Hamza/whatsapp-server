const db = require('../index');

const RoomQueries = {
  /**
   * Create a room.
   * @param {{ type: 'private'|'group', name?: string, createdBy: string }} data
   * @returns {Promise<object>}
   */
  async create({ type, name, createdBy }) {
    const { rows } = await db.query(
      `INSERT INTO rooms (type, name, created_by)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [type, name || null, createdBy],
    );
    return rows[0];
  },

  /**
   * Find a room by id.
   */
  async findById(id) {
    const { rows } = await db.query('SELECT * FROM rooms WHERE id = $1', [id]);
    return rows[0] || null;
  },

  /**
   * Find or create a private room between exactly two users.
   * Prevents duplicate private rooms.
   */
  async findOrCreatePrivate(userIdA, userIdB, createdBy) {
    const { rows } = await db.query(
      `SELECT r.* FROM rooms r
       JOIN room_participants rp1 ON rp1.room_id = r.id AND rp1.user_id = $1
       JOIN room_participants rp2 ON rp2.room_id = r.id AND rp2.user_id = $2
       WHERE r.type = 'private'
       LIMIT 1`,
      [userIdA, userIdB],
    );

    if (rows.length > 0) return { room: rows[0], created: false };

    return db.transaction(async (client) => {
      const { rows: roomRows } = await client.query(
        `INSERT INTO rooms (type, created_by) VALUES ('private', $1) RETURNING *`,
        [createdBy],
      );
      const room = roomRows[0];

      await client.query(
        `INSERT INTO room_participants (room_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
        [room.id, userIdA, userIdB],
      );

      return { room, created: true };
    });
  },

  /**
   * Add a participant to a room.
   */
  async addParticipant(roomId, userId, role = 'member') {
    const { rows } = await db.query(
      `INSERT INTO room_participants (room_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (room_id, user_id) DO UPDATE SET left_at = NULL
       RETURNING *`,
      [roomId, userId, role],
    );
    return rows[0];
  },

  /**
   * Remove a participant (soft-delete via left_at).
   */
  async removeParticipant(roomId, userId) {
    await db.query(
      `UPDATE room_participants SET left_at = NOW()
       WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [roomId, userId],
    );
  },

  /**
   * List active participants of a room.
   */
  async getParticipants(roomId) {
    const { rows } = await db.query(
      `SELECT u.id, u.username, u.profile_picture, u.is_online, rp.role, rp.joined_at
       FROM room_participants rp
       JOIN users u ON u.id = rp.user_id
       WHERE rp.room_id = $1 AND rp.left_at IS NULL
       ORDER BY rp.joined_at`,
      [roomId],
    );
    return rows;
  },

  /**
   * List all rooms a user belongs to (with latest message preview).
   */
  async listByUser(userId) {
    const { rows } = await db.query(
      `SELECT r.*,
              rp.role,
              (SELECT content FROM messages m WHERE m.room_id = r.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
              (SELECT created_at FROM messages m WHERE m.room_id = r.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at
       FROM rooms r
       JOIN room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND rp.left_at IS NULL
       ORDER BY last_message_at DESC NULLS LAST`,
      [userId],
    );
    return rows;
  },
};

module.exports = RoomQueries;
