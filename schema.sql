DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'chat_genius') THEN
        PERFORM dblink_exec('dbname=' || current_database(), 'CREATE DATABASE chat_genius');
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name VARCHAR(255),
    status VARCHAR(50) DEFAULT 'offline'
);

CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    channel_id INT NOT NULL,
    user_id INT NOT NULL,
    content TEXT NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channels (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    is_private BOOLEAN DEFAULT FALSE,
    is_dm BOOLEAN DEFAULT FALSE,
    dm_participants INTEGER[] DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS reactions (
    id SERIAL PRIMARY KEY,
    message_id INT NOT NULL,
    user_id INT NOT NULL,
    emoji VARCHAR(50) NOT NULL
);

CREATE TABLE IF NOT EXISTS user_tokens (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    token VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Function to clean up expired tokens
CREATE OR REPLACE FUNCTION cleanup_expired_tokens()
RETURNS trigger AS $$
BEGIN
    DELETE FROM user_tokens WHERE expires_at < CURRENT_TIMESTAMP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger to clean up expired tokens after each insert
CREATE TRIGGER cleanup_expired_tokens_trigger
    AFTER INSERT ON user_tokens
    EXECUTE FUNCTION cleanup_expired_tokens();

CREATE TABLE IF NOT EXISTS file_attachments (
    id SERIAL PRIMARY KEY,
    message_id INTEGER REFERENCES messages(id),
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    storage_path TEXT NOT NULL,
    is_image BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_status_messages (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    status_message TEXT,
    emoji VARCHAR(32),  -- Store emoji unicode or shortcode
    expires_at TIMESTAMP,  -- Optional: for temporary statuses
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE channels ADD CONSTRAINT unique_channel_name UNIQUE (name);

insert into channels (name) values ('general');

-- Add role-based permissions
ALTER TABLE users ADD COLUMN role VARCHAR(50) DEFAULT 'member';
ALTER TABLE channels ADD COLUMN role VARCHAR(50) DEFAULT 'member';

-- Adding DMs
ALTER TABLE channels ADD COLUMN is_dm BOOLEAN DEFAULT FALSE;
ALTER TABLE channels ADD COLUMN dm_participants INTEGER[] DEFAULT NULL;

ALTER TABLE messages ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE users 
    ADD COLUMN presence_status VARCHAR(20) DEFAULT 'offline',  -- 'online', 'idle', 'offline'
    ADD COLUMN last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- First create the function that will update the timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Then create the trigger that uses this function
CREATE TRIGGER update_user_status_messages_updated_at
    BEFORE UPDATE ON user_status_messages
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS threads (
    id SERIAL PRIMARY KEY,
    channel_id INTEGER NOT NULL REFERENCES channels(id),
    parent_message_id INTEGER NOT NULL REFERENCES messages(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reply_count INTEGER DEFAULT 0,        -- Denormalized counter for quick thread size lookups
    last_reply_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,  -- Denormalized timestamp for efficient thread sorting
    UNIQUE(parent_message_id)  -- Ensure only one thread per message
);

-- Function to clean up duplicate threads
CREATE OR REPLACE FUNCTION cleanup_duplicate_threads()
RETURNS void AS $$
DECLARE
    duplicate RECORD;
BEGIN
    -- Find messages that have multiple threads
    FOR duplicate IN 
        SELECT parent_message_id
        FROM threads
        GROUP BY parent_message_id
        HAVING COUNT(*) > 1
    LOOP
        -- For each duplicate set:
        -- 1. Find the thread with the most replies
        -- 2. Move all replies to that thread
        -- 3. Delete other threads
        WITH ranked_threads AS (
            SELECT t.id,
                   ROW_NUMBER() OVER (PARTITION BY t.parent_message_id ORDER BY t.reply_count DESC) as rn
            FROM threads t
            WHERE t.parent_message_id = duplicate.parent_message_id
        ),
        keeper AS (
            SELECT id FROM ranked_threads WHERE rn = 1
        )
        -- Update all messages to point to the keeper thread
        UPDATE messages
        SET thread_id = (SELECT id FROM keeper)
        WHERE thread_id IN (
            SELECT t.id 
            FROM threads t
            WHERE t.parent_message_id = duplicate.parent_message_id
            AND t.id != (SELECT id FROM keeper)
        );

        -- Delete the duplicate threads
        DELETE FROM threads
        WHERE parent_message_id = duplicate.parent_message_id
        AND id != (SELECT id FROM keeper);
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Run the cleanup
SELECT cleanup_duplicate_threads();

-- Create an index to speed up thread queries
CREATE INDEX messages_thread_id_idx ON messages(thread_id);

-- Add thread_id to messages to identify messages that are replies in a thread
ALTER TABLE messages ADD COLUMN thread_id INTEGER REFERENCES threads(id);

-- Create a trigger to maintain the denormalized thread counters
CREATE OR REPLACE FUNCTION update_thread_counters()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.thread_id IS NOT NULL THEN
        UPDATE threads 
        SET reply_count = reply_count + 1,
            last_reply_at = NEW.created_at
        WHERE id = NEW.thread_id;
    ELSIF TG_OP = 'DELETE' AND OLD.thread_id IS NOT NULL THEN
        UPDATE threads 
        SET reply_count = reply_count - 1,
            last_reply_at = (
                SELECT COALESCE(MAX(created_at), threads.created_at)
                FROM messages 
                WHERE thread_id = OLD.thread_id
            )
        WHERE id = OLD.thread_id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_thread_stats
    AFTER INSERT OR DELETE ON messages
    FOR EACH ROW
    EXECUTE FUNCTION update_thread_counters();