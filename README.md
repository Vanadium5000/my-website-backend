# My Website Backend

## Setup

1. Install sqlx-cli

```bash
cargo install sqlx-cli --no-default-features --features sqlite
```

2. Declare the database URL

```bash
export DATABASE_URL="sqlite:db.sqlite3"
```

3. Create the database

```bash
cargo sqlx db create
```

4. Run sql migrations

```bash
cargo sqlx migrate run
```

5. Start the server

```bash
cargo run
```

## Extra commands

1. Create a sql migration (e.g. called "db")

```bash
cargo sqlx migrate add "db"
```
