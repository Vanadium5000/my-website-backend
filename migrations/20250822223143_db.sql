-- Users
CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin BOOLEAN NOT NULL DEFAULT 0,
    chess_score INTEGER NOT NULL DEFAULT 0,
    is_verified BOOLEAN NOT NULL DEFAULT 0,
    pseudonym TEXT
);

-- Blog posts
CREATE TABLE IF NOT EXISTS blog_posts (
    post_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    snippet TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
    likes INTEGER NOT NULL DEFAULT 0,
    dislikes INTEGER NOT NULL DEFAULT 0,
    comments INTEGER NOT NULL DEFAULT 0
);

-- Blog comments
CREATE TABLE IF NOT EXISTS comments (
    comment_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
    is_accepted BOOLEAN NOT NULL DEFAULT 0,
    FOREIGN KEY (post_id) REFERENCES blog_posts(post_id) ON DELETE CASCADE
);

-- Stores user likes/dislikes user_id & post_id to prevent users liking/disliking multiple posts
CREATE TABLE IF NOT EXISTS user_reactions (
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    is_like BOOLEAN NOT NULL,
    created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
    PRIMARY KEY (user_id, post_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (post_id) REFERENCES blog_posts(post_id) ON DELETE CASCADE
);