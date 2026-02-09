-- =============================================================
-- SimChat Database Schema
-- WhatsApp-like system with messaging, calls, and recordings
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- -----------------------------------------------------------
-- Users
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username        TEXT UNIQUE NOT NULL,
    email           TEXT UNIQUE,
    phone_number    TEXT UNIQUE,
    password        TEXT NOT NULL,
    profile_picture TEXT,
    role            TEXT CHECK (role IN ('admin', 'user')) DEFAULT 'user',
    status          TEXT CHECK (status IN ('pending', 'active', 'rejected')) DEFAULT 'pending',
    is_online       BOOLEAN   DEFAULT FALSE,
    last_seen       TIMESTAMP,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- -----------------------------------------------------------
-- Rooms (private 1-on-1 or group conversations)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS rooms (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type        TEXT CHECK (type IN ('private', 'group')) NOT NULL,
    name        TEXT,
    created_at  TIMESTAMP DEFAULT NOW(),
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL
);

-- -----------------------------------------------------------
-- Room participants (many-to-many between users and rooms)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_participants (
    id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    room_id   UUID NOT NULL REFERENCES rooms(id)  ON DELETE CASCADE,
    user_id   UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    role      TEXT CHECK (role IN ('admin', 'member')) DEFAULT 'member',
    joined_at TIMESTAMP DEFAULT NOW(),
    left_at   TIMESTAMP,
    UNIQUE(room_id, user_id)
);

-- -----------------------------------------------------------
-- Messages
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    room_id      UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    sender_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    content      TEXT,
    message_type TEXT CHECK (message_type IN ('text', 'image', 'audio', 'video', 'file')) DEFAULT 'text',
    file_url     TEXT,
    created_at   TIMESTAMP DEFAULT NOW(),
    edited_at    TIMESTAMP
);

-- -----------------------------------------------------------
-- Message read receipts
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_status (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    status     TEXT CHECK (status IN ('sent', 'delivered', 'read')) DEFAULT 'sent',
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(message_id, user_id)
);

-- -----------------------------------------------------------
-- Calls
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS calls (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    room_id      UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    initiator_id UUID REFERENCES users(id),
    started_at   TIMESTAMP DEFAULT NOW(),
    ended_at     TIMESTAMP,
    call_type    TEXT CHECK (call_type IN ('audio', 'video')) NOT NULL,
    status       TEXT CHECK (status IN ('ringing', 'ongoing', 'completed', 'missed', 'rejected')) DEFAULT 'ringing'
);

-- -----------------------------------------------------------
-- Call participants
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_participants (
    id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    call_id   UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    user_id   UUID NOT NULL REFERENCES users(id),
    joined_at TIMESTAMP DEFAULT NOW(),
    left_at   TIMESTAMP,
    answered  BOOLEAN DEFAULT FALSE
);

-- -----------------------------------------------------------
-- Recordings
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS recordings (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    call_id    UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    file_path  TEXT NOT NULL,
    file_size  BIGINT,
    duration   INTEGER,
    format     TEXT CHECK (format IN ('mp3', 'mp4')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- -----------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_messages_room_created
    ON messages(room_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_sender
    ON messages(sender_id);

CREATE INDEX IF NOT EXISTS idx_calls_room_started
    ON calls(room_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_calls_initiator
    ON calls(initiator_id);

CREATE INDEX IF NOT EXISTS idx_room_participants_user
    ON room_participants(user_id);

CREATE INDEX IF NOT EXISTS idx_room_participants_room
    ON room_participants(room_id);

CREATE INDEX IF NOT EXISTS idx_message_status_message_user
    ON message_status(message_id, user_id);

CREATE INDEX IF NOT EXISTS idx_call_participants_call
    ON call_participants(call_id);

CREATE INDEX IF NOT EXISTS idx_call_participants_user
    ON call_participants(user_id);

CREATE INDEX IF NOT EXISTS idx_recordings_call
    ON recordings(call_id);
