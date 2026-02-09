const db = require('../index');

const UserQueries = {
  /**
   * Create a new user.
   * @param {{ username: string, email?: string, phoneNumber?: string, password: string, profilePicture?: string }} data
   * @returns {Promise<object>} The created user row.
   */
  async create({ username, email, phoneNumber, password, profilePicture, role, status }) {
    const { rows } = await db.query(
      `INSERT INTO users (username, email, phone_number, password, profile_picture, role, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        username,
        email || null,
        phoneNumber || null,
        password,
        profilePicture || null,
        role || 'user',
        status || 'pending',
      ],
    );
    return rows[0];
  },

  /**
   * Find a user by primary key.
   */
  async findById(id) {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] || null;
  },

  /**
   * Find a user by username.
   */
  async findByUsername(username) {
    const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    return rows[0] || null;
  },

  /**
   * Find a user by email.
   */
  async findByEmail(email) {
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] || null;
  },

  /**
   * Set the online status of a user.
   */
  async setOnlineStatus(id, isOnline) {
    const { rows } = await db.query(
      `UPDATE users
       SET is_online  = $2,
           last_seen  = CASE WHEN $2 = FALSE THEN NOW() ELSE last_seen END
       WHERE id = $1
       RETURNING *`,
      [id, isOnline],
    );
    return rows[0] || null;
  },

  /**
   * Update profile fields (username, email, phone, picture).
   */
  async updateProfile(id, fields) {
    const allowed = ['username', 'email', 'phone_number', 'profile_picture'];
    const sets = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(fields)) {
      const column = key.replace(/([A-Z])/g, '_$1').toLowerCase(); // camelCase -> snake_case
      if (allowed.includes(column)) {
        sets.push(`${column} = $${idx}`);
        values.push(value);
        idx++;
      }
    }

    if (sets.length === 0) return this.findById(id);

    values.push(id);
    const { rows } = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    return rows[0] || null;
  },

  /**
   * Update password.
   */
  async updatePassword(id, password) {
    await db.query('UPDATE users SET password = $2 WHERE id = $1', [id, password]);
  },

  /**
   * Set account status (pending, active, rejected).
   */
  async setStatus(id, status) {
    const { rows } = await db.query(
      'UPDATE users SET status = $2 WHERE id = $1 RETURNING *',
      [id, status],
    );
    return rows[0] || null;
  },

  /**
   * List all users with a given status.
   */
  async listByStatus(status, { limit = 50, offset = 0 } = {}) {
    const { rows } = await db.query(
      `SELECT * FROM users WHERE status = $1
       ORDER BY created_at ASC
       LIMIT $2 OFFSET $3`,
      [status, limit, offset],
    );
    return rows;
  },

  /**
   * List every user (admin view). Supports pagination.
   */
  async listAll({ limit = 50, offset = 0 } = {}) {
    const { rows } = await db.query(
      'SELECT * FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset],
    );
    return rows;
  },

  /**
   * Return a safe public projection (no password).
   */
  sanitize(user) {
    if (!user) return null;
    const { password, ...safe } = user;
    return safe;
  },
};

module.exports = UserQueries;
