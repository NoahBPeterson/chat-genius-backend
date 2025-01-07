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
    role VARCHAR(50) DEFAULT 'member',
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

ALTER TABLE channels ADD CONSTRAINT unique_channel_name UNIQUE (name);

insert into channels (name) values ('general');

ALTER TABLE users ADD COLUMN role VARCHAR(50) DEFAULT 'member';
ALTER TABLE channels ADD COLUMN role VARCHAR(50) DEFAULT 'member';

# Adding DMs
ALTER TABLE channels ADD COLUMN is_dm BOOLEAN DEFAULT FALSE;
ALTER TABLE channels ADD COLUMN dm_participants INTEGER[] DEFAULT NULL;

ALTER TABLE messages ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
