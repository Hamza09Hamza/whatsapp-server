require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const db = require('./db');
const queries = require('./db/queries');
const { MediaServer } = require('./mediaServer');

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer storage config
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } }); // 25 MB max

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));

// Initialize Media Server
const mediaServer = new MediaServer();

// In-memory maps kept for socket-level lookups (volatile, not persisted)
const connectedUsers = new Map(); // socketId -> { socketId, userId, username }
const activeCalls = new Map();    // roomId  -> { callId (DB) }

const JWT_SECRET = process.env.JWT_SECRET || 'change_me';

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getLocalIp() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const SERVER_IP = getLocalIp();

// ---------------------------------------------------------------------------
// REST routes -- auth
// ---------------------------------------------------------------------------
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const existing = await queries.users.findByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const user = await queries.users.create({ username, email, password });
    const token = signToken(user.id);

    res.status(201).json({ user: queries.users.sanitize(user), token });
  } catch (err) {
    console.error('[Auth] Register error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = await queries.users.findByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (password !== user.password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.status === 'pending') {
      return res.status(403).json({ error: 'Account pending admin approval' });
    }
    if (user.status === 'rejected') {
      return res.status(403).json({ error: 'Account has been rejected' });
    }

    const token = signToken(user.id);
    await queries.users.setOnlineStatus(user.id, true);

    res.json({ user: queries.users.sanitize(user), token });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed token' });
  }
  try {
    const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function adminMiddleware(req, res, next) {
  try {
    const user = await queries.users.findById(req.userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.adminUser = user;
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// Admin routes -- user approval
// ---------------------------------------------------------------------------

// List pending registration requests
app.get('/api/admin/users/pending', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = parseInt(req.query.offset, 10) || 0;
    const users = await queries.users.listByStatus('pending', { limit, offset });
    res.json({ users: users.map(queries.users.sanitize) });
  } catch (err) {
    console.error('[Admin] List pending error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List all users
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = parseInt(req.query.offset, 10) || 0;
    const users = await queries.users.listAll({ limit, offset });
    res.json({ users: users.map(queries.users.sanitize) });
  } catch (err) {
    console.error('[Admin] List users error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Approve a user
app.post('/api/admin/users/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const user = await queries.users.setStatus(req.params.id, 'active');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: queries.users.sanitize(user) });
  } catch (err) {
    console.error('[Admin] Approve error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reject a user
app.post('/api/admin/users/:id/reject', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const user = await queries.users.setStatus(req.params.id, 'rejected');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: queries.users.sanitize(user) });
  } catch (err) {
    console.error('[Admin] Reject error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// REST route -- file upload
// ---------------------------------------------------------------------------
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const { roomId, senderId, senderUsername, messageType } = req.body;
    if (!roomId || !senderId) {
      return res.status(400).json({ error: 'roomId and senderId are required' });
    }

    const fileUrl = `/uploads/${req.file.filename}`;
    const type = messageType || (req.file.mimetype.startsWith('image/') ? 'image' : 'file');

    // Save message to DB
    const msg = await queries.messages.create({
      roomId,
      senderId,
      content: req.file.originalname,
      messageType: type,
      fileUrl,
    });

    console.log(`[Upload] ${senderUsername || senderId} uploaded ${type}: ${req.file.originalname}`);

    // Emit real-time event to room participants
    try {
      const participants = await queries.rooms.getParticipants(roomId);
      const payload = {
        id: msg.id,
        roomId,
        room_id: roomId,
        senderId,
        sender_id: senderId,
        sender_username: senderUsername || null,
        content: req.file.originalname,
        message_type: type,
        file_url: fileUrl,
        created_at: msg.created_at,
        edited_at: null,
      };
      for (const [sid, u] of connectedUsers.entries()) {
        if (participants.some(p => p.id === u.userId)) {
          io.to(sid).emit('room_message', payload);
        }
      }
    } catch (emitErr) {
      console.error('[Upload] Socket emit error:', emitErr.message);
    }

    res.json({ success: true, messageId: msg.id, fileUrl });
  } catch (err) {
    console.error('[Upload] Error:', err.message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ---------------------------------------------------------------------------
// Helper: resolve a database userId to a live socketId
// ---------------------------------------------------------------------------
function resolveSocketId(userId) {
  for (const [sid, u] of connectedUsers.entries()) {
    if (u.userId === userId) return sid;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log('[Socket] Connected:', socket.id);

  // -- Registration --------------------------------------------------------
  socket.on('register_user', async ({ userId, username }) => {
    connectedUsers.set(socket.id, { socketId: socket.id, userId, username });
    console.log(`[Socket] ${username} registered (userId=${userId})`);

    if (userId) {
      await queries.users.setOnlineStatus(userId, true).catch(() => {});
      // Notify all clients that this user came online
      io.emit('user_status_changed', { userId, username, is_online: true });
    }

    io.emit('users_online', Array.from(connectedUsers.values()));
  });

  // Get current online users
  socket.on('get_online_users', () => {
    socket.emit('users_online', Array.from(connectedUsers.values()));
  });

  // -- Typing indicators ---------------------------------------------------
  socket.on('typing_start', async ({ roomId }) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !roomId) return;
    try {
      const participants = await queries.rooms.getParticipants(roomId);
      for (const [sid, u] of connectedUsers.entries()) {
        if (sid !== socket.id && participants.some(p => p.id === u.userId)) {
          io.to(sid).emit('user_typing', { roomId, userId: user.userId, username: user.username });
        }
      }
    } catch (err) {
      // Fallback: broadcast to all except sender
      socket.broadcast.emit('user_typing', { roomId, userId: user.userId, username: user.username });
    }
  });

  socket.on('typing_stop', async ({ roomId }) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !roomId) return;
    try {
      const participants = await queries.rooms.getParticipants(roomId);
      for (const [sid, u] of connectedUsers.entries()) {
        if (sid !== socket.id && participants.some(p => p.id === u.userId)) {
          io.to(sid).emit('user_stopped_typing', { roomId, userId: user.userId, username: user.username });
        }
      }
    } catch (err) {
      socket.broadcast.emit('user_stopped_typing', { roomId, userId: user.userId, username: user.username });
    }
  });

  // -- Group chat ----------------------------------------------------------
  socket.on('send_group_message', async (data) => {
    const user = connectedUsers.get(socket.id);
    const payload = {
      ...data,
      roomId: data.roomId,
      senderId: user?.userId || null,
      socketId: socket.id,
      timestamp: Date.now(),
    };

    if (data.roomId && user?.userId) {
      try {
        const msg = await queries.messages.create({
          roomId: data.roomId,
          senderId: user.userId,
          content: data.text,
          messageType: 'text',
        });
        payload.messageId = msg.id;
      } catch (err) {
        console.error('[Message] Save error:', err.message);
      }
    }

    // Create 'sent' status rows for every recipient
    if (payload.messageId && data.roomId && user?.userId) {
      try {
        const participants = await queries.rooms.getParticipants(data.roomId);
        for (const p of participants) {
          if (p.id !== user.userId) {
            await queries.messages.setStatus(payload.messageId, p.id, 'sent');
          }
        }
      } catch (err) {
        console.error('[Message] Status insert error:', err.message);
      }
    }

    // Emit only to room participants (not broadcast to everyone)
    if (data.roomId) {
      try {
        const participants = await queries.rooms.getParticipants(data.roomId);
        const participantIds = participants.map(p => p.id);
        for (const [sid, u] of connectedUsers.entries()) {
          if (participantIds.includes(u.userId)) {
            io.to(sid).emit('receive_group_message', payload);
          }
        }
      } catch (err) {
        console.error('[Message] Participant lookup failed, broadcasting:', err.message);
        io.emit('receive_group_message', payload);
      }
    } else {
      io.emit('receive_group_message', payload);
    }
  });

  // -- Private chat --------------------------------------------------------
  socket.on('send_private_message', async ({ recipientId, text, sender, roomId }) => {
    const user = connectedUsers.get(socket.id);

    const messageData = {
      text,
      sender,
      socketId: socket.id,
      senderId: user?.userId || null,
      recipientId,
      roomId,
      timestamp: Date.now(),
    };

    if (roomId && user?.userId) {
      try {
        const msg = await queries.messages.create({
          roomId,
          senderId: user.userId,
          content: text,
          messageType: 'text',
        });
        messageData.messageId = msg.id;
      } catch (err) {
        console.error('[Message] Save error:', err.message);
      }
    }

    // Create 'sent' status row for the recipient
    if (messageData.messageId && recipientId) {
      try {
        await queries.messages.setStatus(messageData.messageId, recipientId, 'sent');
      } catch (err) {
        console.error('[Message] Status insert error:', err.message);
      }
    }

    messageData.delivery_status = 'sent';

    // Find recipient's SOCKET ID by their database user ID
    let recipientSocketId = null;
    for (const [sid, u] of connectedUsers.entries()) {
      if (u.userId === recipientId) {
        recipientSocketId = sid;
        break;
      }
    }

    // Send to recipient (if online) using their socket ID
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('receive_private_message', messageData);
    }
    // Echo back to sender
    socket.emit('receive_private_message', messageData);
  });

  // -- Message history -----------------------------------------------------
  socket.on('get_messages', async ({ roomId, before, limit }, callback) => {
    try {
      const messages = await queries.messages.listByRoom(roomId, { limit, before });
      if (typeof callback === 'function') callback(messages);
    } catch (err) {
      console.error('[Message] get_messages error:', err.message);
      if (typeof callback === 'function') callback([]);
    }
  });

  // -- Delivery confirmation ------------------------------------------------
  socket.on('message_delivered', async ({ messageId }) => {
    const user = connectedUsers.get(socket.id);
    if (!user?.userId || !messageId) return;
    try {
      await queries.messages.setStatus(messageId, user.userId, 'delivered');

      // Find the original message to notify the sender
      const msg = await queries.messages.findById(messageId);
      if (msg && msg.sender_id) {
        const senderSocketId = resolveSocketId(msg.sender_id);
        if (senderSocketId) {
          io.to(senderSocketId).emit('message_status_update', {
            messageId,
            userId: user.userId,
            status: 'delivered',
            roomId: msg.room_id,
          });
        }
      }
    } catch (err) {
      console.error('[Message] Delivered status error:', err.message);
    }
  });

  // -- Read receipts -------------------------------------------------------
  socket.on('mark_read', async ({ roomId }) => {
    const user = connectedUsers.get(socket.id);
    if (!user?.userId) return;
    try {
      await queries.messages.markRoomAs(roomId, user.userId, 'read');

      // Notify all senders in this room that their messages were read
      const recentMessages = await queries.messages.listByRoom(roomId, { limit: 50 });
      const senderIds = [...new Set(recentMessages.filter(m => m.sender_id !== user.userId).map(m => m.sender_id))];
      for (const senderId of senderIds) {
        const senderSocketId = resolveSocketId(senderId);
        if (senderSocketId) {
          io.to(senderSocketId).emit('message_status_update', {
            roomId,
            userId: user.userId,
            status: 'read',
          });
        }
      }
    } catch (err) {
      console.error('[Message] Mark read error:', err.message);
    }
  });

  // -- Rooms ---------------------------------------------------------------

  socket.on('get_rooms', async ({ userId }, callback) => {
    try {
      const rooms = await queries.rooms.listByUser(userId);
      const roomsWithParticipants = await Promise.all(
        rooms.map(async (room) => {
          const participants = await queries.rooms.getParticipants(room.id);
          return { ...room, participants };
        }),
      );
      if (typeof callback === 'function') callback(roomsWithParticipants);
    } catch (err) {
      console.error('[Rooms] get_rooms error:', err.message);
      if (typeof callback === 'function') callback({ error: err.message });
    }
  });

  socket.on('start_private_chat', async ({ targetUserId, userId }, callback) => {
    try {
      const { room, created } = await queries.rooms.findOrCreatePrivate(userId, targetUserId, userId);
      const participants = await queries.rooms.getParticipants(room.id);
      const otherUser = participants.find((p) => p.id !== userId) || null;
      if (typeof callback === 'function') callback({ room: { ...room, participants }, otherUser, created });
    } catch (err) {
      console.error('[Rooms] start_private_chat error:', err.message);
      if (typeof callback === 'function') callback({ error: err.message });
    }
  });

  socket.on('create_group', async ({ name, memberIds, createdBy }, callback) => {
    try {
      const room = await queries.rooms.create({ type: 'group', name, createdBy });
      await queries.rooms.addParticipant(room.id, createdBy, 'admin');
      await Promise.all(
        memberIds.map((memberId) => queries.rooms.addParticipant(room.id, memberId, 'member')),
      );
      const participants = await queries.rooms.getParticipants(room.id);
      if (typeof callback === 'function') callback({ room: { ...room, participants } });
    } catch (err) {
      console.error('[Rooms] create_group error:', err.message);
      if (typeof callback === 'function') callback({ error: err.message });
    }
  });


  /**
   * Join a media room (for calls)
   */
  socket.on('join_media_room', async ({ roomId }, callback) => {
    try {
      const user = connectedUsers.get(socket.id);
      const username = user?.username || 'Anonymous';

      const result = await mediaServer.addPeer(roomId, socket.id, username, SERVER_IP);
      socket.join(roomId);

      console.log(`[Media] ${username} joined room: ${roomId}`);

      callback({
        success: true,
        routerRtpCapabilities: result.routerRtpCapabilities,
      });
    } catch (error) {
      console.error('[Media] join_media_room error:', error.message);
      callback({ success: false, error: error.message });
    }
  });

  /**
   * Set client's RTP capabilities
   */
  socket.on('set_rtp_capabilities', ({ roomId, rtpCapabilities }, callback) => {
    try {
      mediaServer.setPeerRtpCapabilities(roomId, socket.id, rtpCapabilities);
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  /**
   * Create WebRTC transport (for sending or receiving)
   */
  socket.on('create_transport', async ({ roomId, direction }, callback) => {
    try {
      const result = await mediaServer.createWebRtcTransport(roomId, socket.id, SERVER_IP);
      
      // Store transport reference
      mediaServer.storePeerTransport(roomId, socket.id, result.transport, direction);

      callback({
        success: true,
        id: result.id,
        iceParameters: result.iceParameters,
        iceCandidates: result.iceCandidates,
        dtlsParameters: result.dtlsParameters,
      });
    } catch (error) {
      console.error('[Media] create_transport error:', error.message);
      callback({ success: false, error: error.message });
    }
  });

  /**
   * Connect transport
   */
  socket.on('connect_transport', async ({ roomId, transportId, dtlsParameters }, callback) => {
    try {
      await mediaServer.connectTransport(roomId, transportId, dtlsParameters);
      callback({ success: true });
    } catch (error) {
      console.error('[Media] connect_transport error:', error.message);
      callback({ success: false, error: error.message });
    }
  });

  /**
   * Produce media
   */
  socket.on('produce', async ({ roomId, transportId, kind, rtpParameters, appData }, callback) => {
    try {
      const user = connectedUsers.get(socket.id);
      console.log(`[Media] Producing ${kind} from ${user?.username || socket.id}`);

      const result = await mediaServer.produce(roomId, socket.id, transportId, kind, rtpParameters, appData);

      socket.to(roomId).emit('new_producer', {
        producerId: result.id,
        peerId: socket.id,
        kind,
        username: user?.username,
      });

      callback({ success: true, id: result.id });
    } catch (error) {
      console.error('[Media] produce error:', error.message);
      callback({ success: false, error: error.message });
    }
  });

  /**
   * Consume (start receiving media from a producer)
   */
  socket.on('consume', async ({ roomId, producerId }, callback) => {
    try {
      const result = await mediaServer.consume(roomId, socket.id, producerId);
      callback({
        success: true,
        id: result.id,
        producerId: result.producerId,
        kind: result.kind,
        rtpParameters: result.rtpParameters,
        appData: result.appData,
      });
    } catch (error) {
      console.error('[Media] consume error:', error.message);
      callback({ success: false, error: error.message });
    }
  });

  /**
   * Resume consumer (after client is ready)
   */
  socket.on('resume_consumer', async ({ roomId, consumerId }, callback) => {
    try {
      await mediaServer.resumeConsumer(roomId, socket.id, consumerId);
      callback({ success: true });
    } catch (error) {
      console.error('[Media] resume_consumer error:', error.message);
      callback({ success: false, error: error.message });
    }
  });

  /**
   * Get all existing producers in a room
   */
  socket.on('get_producers', ({ roomId }, callback) => {
    try {
      const producers = mediaServer.getProducers(roomId, socket.id);
      callback({ success: true, producers });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  /**
   * Leave media room
   */
  socket.on('leave_media_room', ({ roomId }) => {
    socket.leave(roomId);
    mediaServer.removePeer(socket.id);
    socket.to(roomId).emit('peer_left', { peerId: socket.id });
  });

  // ========================================================================
  // Call lifecycle (DB-backed)
  // ========================================================================

  socket.on('call_user', async ({ userToCall, signalData, from, callerName, isVideoCall, roomId }) => {
    const user = connectedUsers.get(socket.id);
    console.log(`[Call] ${callerName || from} calling ${userToCall} (${isVideoCall ? 'video' : 'audio'})`);

    if (roomId && user?.userId) {
      try {
        const call = await queries.calls.create({
          roomId,
          initiatorId: user.userId,
          callType: isVideoCall ? 'video' : 'audio',
        });
        await queries.calls.addParticipant(call.id, user.userId);
        activeCalls.set(roomId, { callId: call.id });
      } catch (err) {
        console.error('[Call] DB create error:', err.message);
      }
    }

    // Resolve target user's socket ID (userToCall may be a DB userId or socketId)
    let targetSocketId = userToCall;
    // Check if userToCall is a userId (UUID) rather than a socketId
    if (!connectedUsers.has(userToCall)) {
      for (const [sid, u] of connectedUsers.entries()) {
        if (u.userId === userToCall) {
          targetSocketId = sid;
          break;
        }
      }
    }

    io.to(targetSocketId).emit('incoming_call', {
      signal: signalData,
      from: socket.id,
      callerName,
      isVideoCall,
    });

    // Notify the caller that the recipient's device is ringing (only if online)
    if (connectedUsers.has(targetSocketId)) {
      socket.emit('call_ringing');
    }
  });

  socket.on('answer_call', async ({ signal, to, roomId }) => {
    const user = connectedUsers.get(socket.id);
    console.log(`[Call] Answered, sending to ${to}`);

    if (roomId && user?.userId) {
      const active = activeCalls.get(roomId);
      if (active?.callId) {
        try {
          await queries.calls.addParticipant(active.callId, user.userId);
          await queries.calls.answerParticipant(active.callId, user.userId);
          await queries.calls.updateStatus(active.callId, 'ongoing');
        } catch (err) {
          console.error('[Call] DB answer error:', err.message);
        }
      }
    }

    // Resolve target socketId
    let targetSocketId = to;
    if (!connectedUsers.has(to)) {
      for (const [sid, u] of connectedUsers.entries()) {
        if (u.userId === to) {
          targetSocketId = sid;
          break;
        }
      }
    }

    io.to(targetSocketId).emit('call_accepted', { signal });
  });

  socket.on('ice_candidate', ({ candidate, to }) => {
    io.to(to).emit('ice_candidate', { candidate, from: socket.id });
  });

  socket.on('reject_call', async ({ to, roomId }) => {
    console.log(`[Call] Rejected by ${socket.id}`);
    if (roomId) {
      const active = activeCalls.get(roomId);
      if (active?.callId) {
        await queries.calls.updateStatus(active.callId, 'rejected').catch(() => {});
        activeCalls.delete(roomId);
      }
    }

    let targetSocketId = to;
    if (!connectedUsers.has(to)) {
      for (const [sid, u] of connectedUsers.entries()) {
        if (u.userId === to) { targetSocketId = sid; break; }
      }
    }
    io.to(targetSocketId).emit('call_rejected');
  });

  socket.on('end_call', async ({ to, roomId }) => {
    console.log(`[Call] Ended by ${socket.id}`);
    if (roomId) {
      const active = activeCalls.get(roomId);
      if (active?.callId) {
        await queries.calls.end(active.callId).catch(() => {});
        activeCalls.delete(roomId);
      }
    }

    let targetSocketId = to;
    if (!connectedUsers.has(to)) {
      for (const [sid, u] of connectedUsers.entries()) {
        if (u.userId === to) { targetSocketId = sid; break; }
      }
    }
    io.to(targetSocketId).emit('call_ended');
  });

  // ========================================================================
  // Call history and recordings
  // ========================================================================

  socket.on('get_call_history', async ({ roomId, limit, offset }, callback) => {
    try {
      const calls = roomId
        ? await queries.calls.listByRoom(roomId, { limit, offset })
        : [];
      callback({ success: true, calls });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('get_recordings', async ({ callId }, callback) => {
    try {
      const recordings = await queries.recordings.findByCallId(callId);
      callback({ success: true, recordings });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ========================================================================
  // Disconnect
  // ========================================================================

  socket.on('disconnect', async () => {
    const user = connectedUsers.get(socket.id);
    console.log('[Socket] Disconnected:', user?.username || socket.id);

    mediaServer.removePeer(socket.id);

    if (user?.userId) {
      await queries.users.setOnlineStatus(user.userId, false).catch(() => {});
      // Notify all clients that this user went offline
      io.emit('user_status_changed', { userId: user.userId, username: user.username, is_online: false });
    }

    connectedUsers.delete(socket.id);
    io.emit('users_online', Array.from(connectedUsers.values()));
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function startServer() {
  try {
    const dbOk = await db.testConnection();
    if (!dbOk) {
      console.error('[Server] Database connection failed. Exiting.');
      process.exit(1);
    }

    await mediaServer.init();

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log('');
      console.log('='.repeat(40));
      console.log(`  Server running on port ${PORT}`);
      console.log(`  Local IP: ${SERVER_IP}`);
      console.log('='.repeat(40));
      console.log('');
      console.log(`Connect your client to: http://${SERVER_IP}:${PORT}`);
      console.log('');
    });
  } catch (error) {
    console.error('[Server] Failed to start:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Server] Shutting down...');
  await db.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await db.close();
  process.exit(0);
});

startServer();
